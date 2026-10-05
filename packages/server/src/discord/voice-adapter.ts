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
  type AudioResource,
} from '@discordjs/voice';
import type { ChildProcess } from 'node:child_process';
import type {
  VoicePlatformAdapter,
  AudioSource,
  VoicePlatformState,
  VoiceConnectionStatus as CoreVoiceStatus,
  PlaybackStatus,
  AudioTrackInfo,
  AudioFilterConfig,
  AdapterPlayOptions,
} from '@gakki/core';
import {
  createLogger,
  VoicePermissionError,
  LocalAudioSource,
  HttpAudioSource,
} from '@gakki/core';
import '../audio/ffmpeg'; // Ensure FFMPEG_PATH is configured
import { createFilteredFfmpegProcess, clampVolume } from '../audio/audio-filters';
import { RemoteStreamManager, globalRemoteStreamManager } from '../audio/remote-stream';

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
  private readonly activeProcesses = new Map<string, ChildProcess>();
  private readonly activeResources = new Map<string, AudioResource>();
  private readonly channelIds = new Map<string, string>();
  private readonly guildVolumes = new Map<string, number>();
  private readonly guildFilters = new Map<string, AudioFilterConfig>();
  private readonly activeCacheKeys = new Map<string, string>();
  private readonly remoteStreamManager: RemoteStreamManager;

  private readonly stateListeners = new Set<StateChangeListener>();
  private readonly errorListeners = new Set<ErrorListener>();
  private readonly trackEndListeners = new Set<(guildId: string) => void>();

  constructor(
    private readonly client: Client,
    remoteStreamManager: RemoteStreamManager = globalRemoteStreamManager,
  ) {
    this.remoteStreamManager = remoteStreamManager;
  }

  public getClient(): Client {
    return this.client;
  }


  /**
   * Join a voice channel in a guild and subscribe an audio player.
   */
  async joinVoice(guildId: string, channelId: string): Promise<void> {
    logger.info({ guildId, channelId }, '[VOICE] Joining channel');
    this.setVoiceState(guildId, 'CONNECTING');

    const guild = this.client.guilds.cache.get(guildId) ?? await this.client.guilds.fetch(guildId).catch(() => null);
    if (!guild) {
      this.setVoiceState(guildId, 'ERROR');
      throw new Error(`Guild ${guildId} not found in Discord client cache`);
    }

    let channel = guild.channels.cache.get(channelId);
    if (!channel) {
      channel = await guild.channels.fetch(channelId).catch(() => null) as any;
    }
    if (!channel || !channel.isVoiceBased()) {
      this.setVoiceState(guildId, 'ERROR');
      throw new Error(`Voice channel ${channelId} not found in guild ${guildId}`);
    }

    // Verify bot permissions
    const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
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

    // Create voice connection with selfDeaf: false to receive incoming participant audio
    const connection = joinVoiceChannel({
      channelId,
      guildId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    this.connections.set(guildId, connection);
    this.channelIds.set(guildId, channelId);

    // Setup connection listeners
    connection.on(VoiceConnectionStatus.Ready, () => {
      logger.info({ guildId, channelId }, '[VOICE] Connected');
      this.setVoiceState(guildId, 'CONNECTED');
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      logger.warn({ guildId }, '[VOICE] Disconnected or reconnecting...');
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 10_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 10_000),
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
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
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
   * Play an AudioSource on the guild's audio player with optional filters, volume, and seek offset.
   */
  async play(
    guildId: string,
    source: AudioSource,
    options?: AdapterPlayOptions,
  ): Promise<void> {
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

    // Clean up any previously active FFmpeg process for this guild
    const prevProc = this.activeProcesses.get(guildId);
    if (prevProc && !prevProc.killed) {
      prevProc.kill('SIGTERM');
      this.activeProcesses.delete(guildId);
    }

    if (options?.volume !== undefined) {
      this.guildVolumes.set(guildId, clampVolume(options.volume));
    }
    if (options?.filters) {
      this.guildFilters.set(guildId, options.filters);
    }

    let resource: AudioResource;
    let audioPath = source.identifier;

    if ((source as any).isRawPcmStream) {
      const rawStream = await source.getStream();
      resource = createAudioResource(rawStream, {
        inputType: StreamType.Raw,
        inlineVolume: true,
      });
    } else {
      // Determine input path: local file, buffered remote stream, or identifier
      if (source instanceof LocalAudioSource) {
        audioPath = source.resolvedPath;
      } else if (source instanceof HttpAudioSource) {
        const prepared = await this.remoteStreamManager.prepareStream(guildId, source.url, {
          persistent: false,
        });
        audioPath = prepared.filePathOrUrl;
        if (prepared.cacheKey) {
          this.activeCacheKeys.set(guildId, prepared.cacheKey);
        }
      } else {
        audioPath = source.identifier;
      }

      // Create audio resource using FFmpeg filter pipeline (supports local files and buffered streams)
      const activeFilters = options?.filters ?? this.guildFilters.get(guildId);
      const proc = createFilteredFfmpegProcess(audioPath, {
        filters: activeFilters,
        seekSeconds: options?.seekSeconds,
      });
      this.activeProcesses.set(guildId, proc);

      if (!proc.stdout) {
        throw new Error('FFmpeg stdout stream is unavailable');
      }

      resource = createAudioResource(proc.stdout, {
        inputType: StreamType.Raw,
        inlineVolume: true,
      });

      proc.on('exit', () => {
        if (this.activeProcesses.get(guildId) === proc) {
          this.activeProcesses.delete(guildId);
        }
      });
    }

    // Apply configured volume (0.0 to 2.0 linear gain)
    const currentVolume = options?.volume ?? this.guildVolumes.get(guildId) ?? 100;
    if (resource.volume) {
      resource.volume.setVolume(currentVolume / 100);
    }

    this.activeResources.set(guildId, resource);

    resource.playStream.on('error', (streamErr) => {
      logger.error({ err: streamErr, guildId }, '[ERROR] Audio stream error');
      this.setPlayerState(guildId, 'ERROR');
      this.emitError(guildId, streamErr);
    });

    const trackInfo: AudioTrackInfo = {
      name: metadata.title,
      duration: metadata.duration ?? null,
      artist: metadata.artist ?? null,
      filePath: audioPath,
      sourceType: source.sourceType,
    };

    this.currentTracks.set(guildId, trackInfo);

    logger.info({ guildId, title: metadata.title }, '[AUDIO] Starting playback: %s', metadata.title);
    player.play(resource);
  }

  /**
   * Adjust playback volume immediately on the active stream without interruption.
   *
   * @param guildId - Guild identifier
   * @param volume - Level from 0 to 200
   */
  setVolume(guildId: string, volume: number): void {
    const clamped = clampVolume(volume);
    this.guildVolumes.set(guildId, clamped);

    const resource = this.activeResources.get(guildId);
    if (resource?.volume) {
      resource.volume.setVolume(clamped / 100);
    }
  }

  /**
   * Rebuild the audio processing pipeline with new audio filters while playing,
   * resuming at the elapsed playback position as closely as practical.
   *
   * @param guildId - Guild identifier
   * @param filters - New filter configuration
   * @param seekSeconds - Optional explicit seek position in seconds
   */
  async rebuildCurrentStream(
    guildId: string,
    filters: AudioFilterConfig,
    seekSeconds?: number,
  ): Promise<void> {
    const currentTrack = this.currentTracks.get(guildId);
    if (!currentTrack || !currentTrack.filePath) {
      return;
    }

    const player = this.players.get(guildId);
    if (!player) return;

    const oldResource = this.activeResources.get(guildId);
    const elapsed =
      seekSeconds !== undefined
        ? seekSeconds
        : Math.floor((oldResource?.playbackDuration || 0) / 1000);

    // Terminate old FFmpeg process
    const prevProc = this.activeProcesses.get(guildId);
    if (prevProc && !prevProc.killed) {
      prevProc.kill('SIGTERM');
      this.activeProcesses.delete(guildId);
    }

    this.guildFilters.set(guildId, filters);

    // Spawn new FFmpeg process seeking to current elapsed playback time
    const proc = createFilteredFfmpegProcess(currentTrack.filePath, {
      filters,
      seekSeconds: elapsed,
    });
    this.activeProcesses.set(guildId, proc);

    if (!proc.stdout) {
      throw new Error('FFmpeg stdout stream is unavailable');
    }

    const newResource = createAudioResource(proc.stdout, {
      inputType: StreamType.Raw,
      inlineVolume: true,
    });

    const currentVolume = this.guildVolumes.get(guildId) ?? 100;
    if (newResource.volume) {
      newResource.volume.setVolume(currentVolume / 100);
    }

    this.activeResources.set(guildId, newResource);

    newResource.playStream.on('error', (streamErr) => {
      logger.error({ err: streamErr, guildId }, '[ERROR] Rebuilt stream error');
      this.setPlayerState(guildId, 'ERROR');
      this.emitError(guildId, streamErr);
    });

    logger.info(
      { guildId, track: currentTrack.name, elapsed, filters },
      '[AUDIO] FFmpeg pipeline rebuilt',
    );
    player.play(newResource);
  }

  /**
   * Get elapsed playback duration in milliseconds for the current track.
   */
  getPlaybackDuration(guildId: string): number {
    const resource = this.activeResources.get(guildId);
    return resource?.playbackDuration || 0;
  }

  /**
   * Get the number of non-bot human members in the bot's current voice channel.
   */
  getHumanCount(guildId: string): number {
    const channelId = this.channelIds.get(guildId);
    if (!channelId) return 0;

    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return 0;

    let count = 0;
    for (const [userId, vs] of guild.voiceStates.cache) {
      if (vs.channelId === channelId) {
        if (userId === this.client.user?.id) continue;
        const user = this.client.users.cache.get(userId) || vs.member?.user;
        if (user?.bot) continue;
        count++;
      }
    }
    return count;
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
    const proc = this.activeProcesses.get(guildId);
    if (proc && !proc.killed) {
      proc.kill('SIGTERM');
      this.activeProcesses.delete(guildId);
    }
    this.activeResources.delete(guildId);

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

  onTrackEnd(listener: (guildId: string) => void): void {
    this.trackEndListeners.add(listener);
  }

  getConnection(guildId: string): VoiceConnection | undefined {
    return this.connections.get(guildId);
  }

  getChannelId(guildId: string): string | undefined {
    return this.channelIds.get(guildId);
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
      logger.info({ guildId }, '[AUDIO] Idle');
      this.currentTracks.set(guildId, null);
      this.setPlayerState(guildId, 'IDLE');
      for (const listener of this.trackEndListeners) {
        try {
          listener(guildId);
        } catch (err) {
          logger.error({ err, guildId }, 'Error in trackEnd listener');
        }
      }
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
    const proc = this.activeProcesses.get(guildId);
    if (proc && !proc.killed) {
      proc.kill('SIGTERM');
      this.activeProcesses.delete(guildId);
    }
    this.activeResources.delete(guildId);
    this.channelIds.delete(guildId);
    this.connections.delete(guildId);
    const player = this.players.get(guildId);
    if (player) {
      player.stop(true);
      this.players.delete(guildId);
    }
    this.currentTracks.delete(guildId);

    // Abort pending remote stream and clean up ephemeral cache file
    this.remoteStreamManager.abortGuildStream(guildId);
    const cacheKey = this.activeCacheKeys.get(guildId);
    if (cacheKey) {
      this.remoteStreamManager.cleanupStream(cacheKey);
      this.activeCacheKeys.delete(guildId);
    }
  }

  getCapabilities(): import('@gakki/core').VoicePlatformCapabilities {
    return {
      sendAudio: true,
      receiveAudio: true,
      receiveVideo: false,
      participantMetadata: true,
      recording: true,
    };
  }

  getParticipants(guildId?: string): import('@gakki/core').PlatformParticipant[] {
    if (!this.client || !guildId) return [];
    const channelId = this.channelIds.get(guildId);
    if (!channelId) return [];

    const channel = this.client.channels?.cache?.get(channelId);
    if (channel && 'members' in channel && channel.members) {
      return Array.from((channel.members as any).values()).map((m: any) => ({
        platform: 'discord',
        platformParticipantId: m.id,
        displayName: m.displayName || m.user?.username || 'Discord User',
        avatarUrl: m.user?.displayAvatarURL?.(),
        joinedAt: new Date(),
      }));
    }
    return [];
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
