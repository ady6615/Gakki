import type { Client } from 'discord.js';
import { PermissionsBitField } from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  NoSubscriberBehavior,
  StreamType,
  type VoiceConnection,
  type AudioPlayer,
} from '@discordjs/voice';
import type {
  VoicePlatformAdapter,
  AudioSource,
  VoicePlatformState,
  VoiceConnectionStatus as CoreVoiceStatus,
  PlaybackStatus,
  AudioTrackInfo,
} from '@gakki/core';
import {
  createLogger,
  VoicePermissionError,
  LocalAudioSource,
} from '@gakki/core';
import '../audio/ffmpeg'; // Ensure FFMPEG_PATH is configured

const logger = createLogger('discord-voice');

type StateChangeListener = (state: VoicePlatformState) => void;
type ErrorListener = (guildId: string, error: Error) => void;

/**
 * Discord implementation of VoicePlatformAdapter.
 *
 * Bridges @discordjs/voice connections and players with the platform-agnostic
 * Gakki core engine. Manages connection lifecycles, player subscriptions,
 * error translations, and resource cleanups.
 */
export class DiscordVoiceAdapter implements VoicePlatformAdapter {
  readonly platform = 'discord' as const;

  private readonly connections = new Map<string, VoiceConnection>();
  private readonly players = new Map<string, AudioPlayer>();
  private readonly currentTracks = new Map<string, AudioTrackInfo | null>();
  private readonly voiceStates = new Map<string, CoreVoiceStatus>();
  private readonly playerStates = new Map<string, PlaybackStatus>();

  private readonly stateListeners = new Set<StateChangeListener>();
  private readonly errorListeners = new Set<ErrorListener>();

  constructor(private readonly client: Client) {}

  /**
   * Join a voice channel in a guild and subscribe an audio player.
   */
  async joinVoice(guildId: string, channelId: string): Promise<void> {
    logger.info({ guildId, channelId }, '[VOICE] Joining channel');
    this.setVoiceState(guildId, 'CONNECTING');

    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) {
      this.setVoiceState(guildId, 'ERROR');
      throw new Error(`Guild ${guildId} not found in Discord client cache`);
    }

    const channel = guild.channels.cache.get(channelId);
    if (!channel || !channel.isVoiceBased()) {
      this.setVoiceState(guildId, 'ERROR');
      throw new Error(`Voice channel ${channelId} not found in guild ${guildId}`);
    }

    // Verify bot permissions
    const me = guild.members.me;
    if (me) {
      const permissions = channel.permissionsFor(me);
      if (
        !permissions ||
        !permissions.has([PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak])
      ) {
        logger.error({ guildId, channelId }, '[ERROR] Missing Connect or Speak permissions');
        this.setVoiceState(guildId, 'ERROR');
        throw new VoicePermissionError(['Connect', 'Speak']);
      }
    }

    // Reuse existing connection if already connected to this channel
    const existing = this.connections.get(guildId);
    if (existing && existing.joinConfig.channelId === channelId) {
      if (existing.state.status === VoiceConnectionStatus.Ready) {
        this.setVoiceState(guildId, 'CONNECTED');
        return;
      }
    } else if (existing) {
      existing.destroy();
      this.connections.delete(guildId);
    }

    // Create voice connection
    const connection = joinVoiceChannel({
      channelId,
      guildId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });

    this.connections.set(guildId, connection);

    // Setup connection listeners
    connection.on(VoiceConnectionStatus.Ready, () => {
      logger.info({ guildId, channelId }, '[VOICE] Connected');
      this.setVoiceState(guildId, 'CONNECTED');
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      logger.warn({ guildId }, '[VOICE] Disconnected or reconnecting...');
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        // Successfully reconnected or reconnecting
      } catch {
        logger.info({ guildId }, '[VOICE] Disconnected');
        this.leaveVoice(guildId).catch(() => {});
      }
    });

    connection.on(VoiceConnectionStatus.Destroyed, () => {
      this.cleanupGuild(guildId);
      this.setVoiceState(guildId, 'DISCONNECTED');
    });

    connection.on('error', (error) => {
      logger.error({ err: error, guildId }, '[ERROR] Voice connection error');
      this.setVoiceState(guildId, 'ERROR');
      this.emitError(guildId, error);
    });

    // Create & subscribe audio player
    const player = this.getOrCreatePlayer(guildId);
    connection.subscribe(player);

    // Wait until connection is ready with a timeout
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    } catch (error) {
      logger.error({ err: error, guildId }, '[ERROR] Failed to reach Ready voice connection state');
      connection.destroy();
      this.cleanupGuild(guildId);
      this.setVoiceState(guildId, 'ERROR');
      throw error;
    }
  }

  /**
   * Disconnect from voice and clean up all resources.
   */
  async leaveVoice(guildId: string): Promise<void> {
    this.stop(guildId);

    const connection = this.connections.get(guildId);
    if (connection) {
      try {
        connection.destroy();
      } catch {
        // Connection already destroyed
      }
    }

    logger.info({ guildId }, '[VOICE] Disconnected');
    this.cleanupGuild(guildId);
    this.setVoiceState(guildId, 'DISCONNECTED');
  }

  getVoiceStatus(guildId: string): CoreVoiceStatus {
    return this.voiceStates.get(guildId) || 'DISCONNECTED';
  }

  /**
   * Play an AudioSource on the guild's audio player.
   */
  async play(guildId: string, source: AudioSource): Promise<void> {
    const connection = this.connections.get(guildId);
    if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) {
      throw new Error('Not connected to a voice channel. Use /join first or specify a channel.');
    }

    // Validate audio source
    await source.validate();

    // Probe/extract metadata
    const metadata = await source.getMetadata();
    logger.info({ guildId, title: metadata.title }, '[AUDIO] Loading track: %s', metadata.title);

    const player = this.getOrCreatePlayer(guildId);

    // Create audio resource using FFmpeg
    let resource;
    if (source instanceof LocalAudioSource) {
      resource = createAudioResource(source.resolvedPath, {
        inputType: StreamType.Arbitrary,
        inlineVolume: true,
      });
    } else {
      const stream = await source.getStream();
      resource = createAudioResource(stream, {
        inputType: StreamType.Arbitrary,
        inlineVolume: true,
      });
    }

    resource.playStream.on('error', (streamErr) => {
      logger.error({ err: streamErr, guildId }, '[ERROR] Audio stream error');
      this.setPlayerState(guildId, 'ERROR');
      this.emitError(guildId, streamErr);
    });

    const trackInfo: AudioTrackInfo = {
      name: metadata.title,
      duration: metadata.duration ?? null,
      artist: metadata.artist ?? null,
      filePath: source instanceof LocalAudioSource ? source.resolvedPath : source.identifier,
      sourceType: source.sourceType,
    };

    this.currentTracks.set(guildId, trackInfo);

    logger.info({ guildId, title: metadata.title }, '[AUDIO] Starting playback: %s', metadata.title);
    player.play(resource);
  }

  pause(guildId: string): boolean {
    const player = this.players.get(guildId);
    if (!player) return false;

    const paused = player.pause();
    if (paused) {
      logger.info({ guildId }, '[AUDIO] Paused');
      this.setPlayerState(guildId, 'PAUSED');
    }
    return paused;
  }

  resume(guildId: string): boolean {
    const player = this.players.get(guildId);
    if (!player) return false;

    const resumed = player.unpause();
    if (resumed) {
      logger.info({ guildId }, '[AUDIO] Resumed');
      this.setPlayerState(guildId, 'PLAYING');
    }
    return resumed;
  }

  stop(guildId: string): boolean {
    const player = this.players.get(guildId);
    if (!player) return false;

    const stopped = player.stop(true);
    logger.info({ guildId }, '[AUDIO] Stopped');
    this.currentTracks.set(guildId, null);
    this.setPlayerState(guildId, 'IDLE');
    return stopped;
  }

  getPlaybackStatus(guildId: string): PlaybackStatus {
    return this.playerStates.get(guildId) || 'IDLE';
  }

  getCurrentTrack(guildId: string): AudioTrackInfo | null {
    return this.currentTracks.get(guildId) || null;
  }

  getState(guildId: string): VoicePlatformState {
    return {
      guildId,
      voiceState: this.voiceStates.get(guildId) || 'DISCONNECTED',
      playerState: this.playerStates.get(guildId) || 'IDLE',
      track: this.currentTracks.get(guildId) || null,
    };
  }

  onStateChange(listener: StateChangeListener): void {
    this.stateListeners.add(listener);
  }

  onError(listener: ErrorListener): void {
    this.errorListeners.add(listener);
  }

  private getOrCreatePlayer(guildId: string): AudioPlayer {
    let player = this.players.get(guildId);
    if (player) return player;

    player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause,
      },
    });

    player.on(AudioPlayerStatus.Playing, () => {
      this.setPlayerState(guildId, 'PLAYING');
    });

    player.on(AudioPlayerStatus.Paused, () => {
      this.setPlayerState(guildId, 'PAUSED');
    });

    player.on(AudioPlayerStatus.Idle, () => {
      logger.info({ guildId }, '[AUDIO] Stopped');
      this.currentTracks.set(guildId, null);
      this.setPlayerState(guildId, 'IDLE');
    });

    player.on('error', (error) => {
      logger.error({ err: error, guildId }, '[ERROR] Audio player error: %s', error.message);
      this.setPlayerState(guildId, 'ERROR');
      this.emitError(guildId, error);
    });

    this.players.set(guildId, player);
    return player;
  }

  private cleanupGuild(guildId: string): void {
    this.connections.delete(guildId);
    const player = this.players.get(guildId);
    if (player) {
      player.stop(true);
      this.players.delete(guildId);
    }
    this.currentTracks.delete(guildId);
  }

  private setVoiceState(guildId: string, state: CoreVoiceStatus): void {
    this.voiceStates.set(guildId, state);
    this.emitState(guildId);
  }

  private setPlayerState(guildId: string, state: PlaybackStatus): void {
    this.playerStates.set(guildId, state);
    this.emitState(guildId);
  }

  private emitState(guildId: string): void {
    const currentState = this.getState(guildId);
    for (const listener of this.stateListeners) {
      try {
        listener(currentState);
      } catch (err) {
        logger.error({ err }, 'Error invoking state listener');
      }
    }
  }

  private emitError(guildId: string, error: Error): void {
    for (const listener of this.errorListeners) {
      try {
        listener(guildId, error);
      } catch (err) {
        logger.error({ err }, 'Error invoking error listener');
      }
    }
  }
}
