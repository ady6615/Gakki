import type { Logger } from 'pino';
import { randomUUID } from 'node:crypto';
import type { AudioSource } from '../audio/audio-source';
import { LocalAudioSource } from '../audio/local-audio.source';
import { HttpAudioSource } from '../audio/http-audio.source';
import type { VoicePlatformAdapter, AdapterPlayOptions } from '../types/platform';
import type {
  VoicePlatformState,
  PlaybackStatus,
} from '../types/audio';
import type {
  QueueTrack,
  QueueUpdatedEvent,
  PlaybackEndReason,
  AudioFilterConfig,
  LoopMode,
  GuildPlaybackState,
  GuildSettings,
  PlaybackSettingsUpdatedEvent,
  GuildSettingsUpdatedEvent,
  VoiceLifecycleUpdatedEvent,
} from '../types/queue';
import { QueueManager } from './queue.manager';
import { VoiceLifecycleManager } from './voice-lifecycle.manager';
import type { GuildSettingsManager } from './guild-settings.manager';

type StateChangeListener = (state: VoicePlatformState) => void;
type QueueUpdateListener = (event: QueueUpdatedEvent) => void;
type SettingsUpdateListener = (event: PlaybackSettingsUpdatedEvent | GuildSettingsUpdatedEvent) => void;
type LifecycleUpdateListener = (event: VoiceLifecycleUpdatedEvent) => void;
type ErrorListener = (guildId: string, error: Error) => void;

/**
 * Manages audio playback coordination, queue advancement, audio effects,
 * and voice lifecycles across platforms.
 *
 * Responsibilities:
 * - Coordinates play / pause / stop / skip / advance commands
 * - Interacts with QueueManager for FIFO queue operations, shuffling, moving, removing
 * - Interacts with VoicePlatformAdapter (Discord, etc.) for voice output and audio streams
 * - Manages per-guild volume (0-200), audio filters (bassboost, speed, nightcore)
 * - Rebuilds audio pipeline when filters change during playback
 * - Manages loop modes ('off' | 'track' | 'queue') with deterministic skip/clear semantics
 * - Manages voice channel inactivity timers via VoiceLifecycleManager
 * - Emits queue, settings, and lifecycle state update events for WebSocket / API
 */
export class PlaybackManager {
  private adapter: VoicePlatformAdapter | null = null;
  private readonly currentTracks = new Map<string, QueueTrack | null>();
  private readonly endReasons = new Map<string, PlaybackEndReason>();
  private readonly isAdvancing = new Map<string, boolean>();

  // Authoritative guild audio & playback settings
  private readonly guildVolumes = new Map<string, number>();
  private readonly guildFilters = new Map<string, AudioFilterConfig>();
  private readonly guildLoopModes = new Map<string, LoopMode>();

  public readonly voiceLifecycleManager: VoiceLifecycleManager;

  private readonly stateListeners = new Set<StateChangeListener>();
  private readonly queueListeners = new Set<QueueUpdateListener>();
  private readonly settingsListeners = new Set<SettingsUpdateListener>();
  private readonly lifecycleListeners = new Set<LifecycleUpdateListener>();
  private readonly errorListeners = new Set<ErrorListener>();

  constructor(
    private readonly logger: Logger,
    public readonly queueManager: QueueManager,
    defaultTimeoutSeconds: number = 300,
    public readonly guildSettingsManager?: GuildSettingsManager,
  ) {
    this.logger.debug('PlaybackManager initialized');

    this.voiceLifecycleManager = new VoiceLifecycleManager(
      this.logger,
      {
        onAutoLeave: async (guildId, reason) => {
          this.logger.info(
            { guildId, reason },
            '[VOICE] Auto-leave triggered — disconnecting from voice channel',
          );
          try {
            await this.leave(guildId);
          } catch (err) {
            this.logger.error({ err, guildId }, 'Error executing auto-leave');
          }
        },
        onLifecycleUpdate: (guildId, info) => {
          this.emitLifecycleUpdate(guildId, info);
        },
      },
      defaultTimeoutSeconds,
    );

    // Forward queue changes to queue update listeners
    this.queueManager.onQueueChange((guildId) => {
      this.emitQueueUpdate(guildId);
    });

    // If persistent settings manager is provided, preload settings
    if (this.guildSettingsManager) {
      this.guildSettingsManager.loadAllSettings().then((allSettings) => {
        for (const [guildId, s] of allSettings) {
          this.guildVolumes.set(guildId, s.volume);
          this.guildFilters.set(guildId, s.filters);
          this.guildLoopModes.set(guildId, s.loopMode);
          this.voiceLifecycleManager.setStayInChannel(guildId, s.stayInChannel);
          this.voiceLifecycleManager.setTimeoutSeconds(guildId, s.voiceIdleTimeout);
        }
      }).catch((err) => {
        this.logger.error({ err }, 'Failed to pre-load guild settings in PlaybackManager');
      });
    }
  }

  /**
   * Create an AudioSource appropriate for the given track (local file or HTTP stream).
   */
  public createAudioSource(track: QueueTrack): AudioSource {
    if (track.path.startsWith('http://') || track.path.startsWith('https://')) {
      return new HttpAudioSource(track.path, {
        title: track.name,
        artist: track.artist ?? null,
        album: track.album ?? null,
        duration: track.duration ?? null,
      });
    }
    return new LocalAudioSource(track.path);
  }

  /**
   * Persist guild settings asynchronously to PostgreSQL.
   */
  private saveGuildSettings(guildId: string): void {
    if (!this.guildSettingsManager) return;
    const settings: GuildSettings = {
      guildId,
      volume: this.getVolume(guildId),
      filters: this.getFilters(guildId),
      loopMode: this.getLoopMode(guildId),
      stayInChannel: this.isStayInChannel(guildId),
      voiceIdleTimeout: this.voiceLifecycleManager.getTimeoutSeconds(guildId),
    };
    this.guildSettingsManager.saveSettings(settings).catch((err) => {
      this.logger.error({ err, guildId }, 'Failed to persist guild settings asynchronously');
    });
  }

  /**
   * Explicitly load settings for a guild from PostgreSQL if not already in memory.
   */
  async loadGuildSettings(guildId: string): Promise<GuildSettings | null> {
    if (!this.guildSettingsManager) return null;
    const settings = await this.guildSettingsManager.getSettings(guildId);
    this.guildVolumes.set(guildId, settings.volume);
    this.guildFilters.set(guildId, settings.filters);
    this.guildLoopModes.set(guildId, settings.loopMode);
    this.voiceLifecycleManager.setStayInChannel(guildId, settings.stayInChannel);
    this.voiceLifecycleManager.setTimeoutSeconds(guildId, settings.voiceIdleTimeout);
    return settings;
  }

  /**
   * Register a voice platform adapter (e.g. DiscordVoiceAdapter).
   */
  registerAdapter(adapter: VoicePlatformAdapter): void {
    this.adapter = adapter;
    this.logger.info({ platform: adapter.platform }, 'Voice platform adapter registered in PlaybackManager');

    adapter.onStateChange((state) => {
      for (const listener of this.stateListeners) {
        try {
          listener(state);
        } catch (err) {
          this.logger.error({ err }, 'Error in state change listener');
        }
      }
    });

    adapter.onError((guildId, error) => {
      for (const listener of this.errorListeners) {
        try {
          listener(guildId, error);
        } catch (err) {
          this.logger.error({ err, guildId }, 'Error in error listener');
        }
      }
    });

    // Listen to natural track completion from the voice adapter
    if (adapter.onTrackEnd) {
      adapter.onTrackEnd(async (guildId) => {
        const reason = this.endReasons.get(guildId) || 'finished';
        if (reason === 'finished') {
          this.logger.info({ guildId }, '[PLAYBACK] Track finished');

          const loopMode = this.getLoopMode(guildId);

          if (loopMode === 'track') {
            // Repeat the current track without dequeuing
            const current = this.currentTracks.get(guildId);
            if (current) {
              await this.replayCurrentTrack(guildId, current);
              return;
            }
          } else if (loopMode === 'queue') {
            // Re-enqueue current track at the end of the queue
            const current = this.currentTracks.get(guildId);
            if (current) {
              this.queueManager.addTrack(guildId, current);
            }
          }

          // Advance queue to next track
          const advanced = await this.advanceQueue(guildId);
          if (!advanced && this.queueManager.isEmpty(guildId)) {
            this.voiceLifecycleManager.handleQueueBecameEmpty(guildId);
          }
        } else {
          this.logger.debug({ guildId, reason }, '[PLAYBACK] Player became idle with reason: %s', reason);
          // Reset reason back to default 'finished' for next playback
          this.endReasons.set(guildId, 'finished');
        }
      });
    }
  }

  getAdapter(): VoicePlatformAdapter | null {
    return this.adapter;
  }

  private ensureAdapter(): VoicePlatformAdapter {
    if (!this.adapter) {
      throw new Error('No voice platform adapter registered in PlaybackManager');
    }
    return this.adapter;
  }

  async join(guildId: string, channelId: string, options?: unknown): Promise<void> {
    const adapter = this.ensureAdapter();
    await adapter.joinVoice(guildId, channelId, options);
    this.voiceLifecycleManager.setBotConnected(guildId, true);

    if (adapter.getHumanCount) {
      this.voiceLifecycleManager.handleHumanCountChange(guildId, adapter.getHumanCount(guildId));
    }
  }

  async leave(guildId: string): Promise<void> {
    const adapter = this.ensureAdapter();
    this.endReasons.set(guildId, 'stopped');
    await adapter.leaveVoice(guildId);
    this.voiceLifecycleManager.setBotConnected(guildId, false);
    this.voiceLifecycleManager.cleanup(guildId);
    this.currentTracks.delete(guildId);
    this.queueManager.clearQueue(guildId);
    this.emitQueueUpdate(guildId);
  }

  /**
   * Play a track or enqueue if a track is already playing.
   */
  async play(
    guildId: string,
    source: AudioSource,
    metadata: {
      name: string;
      path: string;
      duration?: number;
      artist?: string | null;
      addedBy?: string;
    },
  ): Promise<{ status: 'started' | 'queued'; track: QueueTrack; position?: number }> {
    const adapter = this.ensureAdapter();
    const playerStatus = adapter.getPlaybackStatus(guildId);

    const track: QueueTrack = {
      id: randomUUID(),
      name: metadata.name,
      path: metadata.path,
      duration: metadata.duration,
      artist: metadata.artist,
      addedBy: metadata.addedBy,
    };

    // If already playing or paused, add to queue
    if (playerStatus === 'PLAYING' || playerStatus === 'PAUSED') {
      this.queueManager.addTrack(guildId, track);
      const position = this.queueManager.getQueueLength(guildId);
      this.emitQueueUpdate(guildId);
      return { status: 'queued', track, position };
    }

    // Nothing currently playing: start playback immediately
    await source.validate();
    this.endReasons.set(guildId, 'finished');
    this.currentTracks.set(guildId, track);

    this.logger.info(
      { guildId, trackId: track.id, name: track.name },
      '[PLAYBACK] Track started: %s',
      track.name,
    );

    this.voiceLifecycleManager.handleTrackStarted(guildId);

    const playOptions: AdapterPlayOptions = {
      volume: this.getVolume(guildId),
      filters: this.getFilters(guildId),
    };

    await adapter.play(guildId, source, playOptions);
    this.emitQueueUpdate(guildId);
    return { status: 'started', track };
  }

  /**
   * Replay current track in place for track loop mode.
   */
  private async replayCurrentTrack(guildId: string, track: QueueTrack): Promise<void> {
    try {
      const adapter = this.ensureAdapter();
      const source = this.createAudioSource(track);
      await source.validate();

      this.endReasons.set(guildId, 'finished');
      this.logger.info(
        { guildId, trackId: track.id, name: track.name },
        '[PLAYBACK] Track started: %s (loop track)',
        track.name,
      );

      this.voiceLifecycleManager.handleTrackStarted(guildId);

      const playOptions: AdapterPlayOptions = {
        volume: this.getVolume(guildId),
        filters: this.getFilters(guildId),
      };

      await adapter.play(guildId, source, playOptions);
      this.emitQueueUpdate(guildId);
    } catch (err) {
      this.logger.error(
        { err, guildId, track: track.name },
        '[PLAYBACK] Track failed during loop: %s',
        track.name,
      );
      await this.advanceQueue(guildId);
    }
  }

  /**
   * Advance to the next track in the queue.
   * Skips failed tracks with error logging up to a maximum attempt limit.
   */
  async advanceQueue(guildId: string): Promise<boolean> {
    if (this.isAdvancing.get(guildId)) {
      return false;
    }
    this.isAdvancing.set(guildId, true);

    try {
      const adapter = this.ensureAdapter();
      let nextTrack = this.queueManager.getNext(guildId);

      if (!nextTrack) {
        this.logger.info({ guildId }, '[PLAYBACK] Queue empty, remaining idle');
        this.currentTracks.set(guildId, null);
        this.emitQueueUpdate(guildId);
        return false;
      }

      this.logger.info(
        { guildId, trackId: nextTrack.id, name: nextTrack.name },
        '[PLAYBACK] Advancing queue: %s',
        nextTrack.name,
      );

      // Attempt playback, advancing past failed tracks safely
      let attempts = 0;
      const maxAttempts = 5;

      while (nextTrack && attempts < maxAttempts) {
        attempts++;
        try {
          const source = this.createAudioSource(nextTrack);
          await source.validate();

          this.endReasons.set(guildId, 'finished');
          this.currentTracks.set(guildId, nextTrack);

          this.logger.info(
            { guildId, trackId: nextTrack.id, name: nextTrack.name },
            '[PLAYBACK] Track started: %s',
            nextTrack.name,
          );

          this.voiceLifecycleManager.handleTrackStarted(guildId);

          const playOptions: AdapterPlayOptions = {
            volume: this.getVolume(guildId),
            filters: this.getFilters(guildId),
          };

          await adapter.play(guildId, source, playOptions);
          this.emitQueueUpdate(guildId);
          return true;
        } catch (err) {
          this.logger.error(
            { err, guildId, track: nextTrack.name },
            '[PLAYBACK] Track failed: %s',
            nextTrack.name,
          );
          // Try next track in queue
          nextTrack = this.queueManager.getNext(guildId);
        }
      }

      if (attempts >= maxAttempts) {
        this.logger.warn({ guildId }, '[PLAYBACK] Exceeded maximum consecutive track failure attempts');
      }

      this.currentTracks.set(guildId, null);
      this.emitQueueUpdate(guildId);
      return false;
    } finally {
      this.isAdvancing.set(guildId, false);
    }
  }

  /**
   * Skip current track and advance immediately to the next track in queue.
   * Breaks track loop mode repetition cleanly to prevent infinite loop on skip.
   */
  async skip(guildId: string): Promise<{ skipped: boolean; nowPlaying?: QueueTrack | null }> {
    const adapter = this.ensureAdapter();
    const status = adapter.getPlaybackStatus(guildId);

    if (status === 'IDLE' && this.queueManager.isEmpty(guildId)) {
      return { skipped: false };
    }

    // Stop current track cleanly with 'stopped' reason so its Idle event won't trigger duplicate advance
    this.endReasons.set(guildId, 'stopped');
    adapter.stop(guildId);

    // Dequeue next track directly (breaks track loop repetition)
    const nextTrack = this.queueManager.getNext(guildId);
    if (!nextTrack) {
      this.currentTracks.set(guildId, null);
      this.emitQueueUpdate(guildId);
      this.voiceLifecycleManager.handleQueueBecameEmpty(guildId);
      return { skipped: true, nowPlaying: null };
    }

    this.logger.info(
      { guildId, trackId: nextTrack.id, name: nextTrack.name },
      '[PLAYBACK] Advancing queue: %s',
      nextTrack.name,
    );

    // Play next track
    try {
      const source = this.createAudioSource(nextTrack);
      await source.validate();
      this.endReasons.set(guildId, 'finished');
      this.currentTracks.set(guildId, nextTrack);

      this.logger.info(
        { guildId, trackId: nextTrack.id, name: nextTrack.name },
        '[PLAYBACK] Track started: %s',
        nextTrack.name,
      );

      this.voiceLifecycleManager.handleTrackStarted(guildId);

      const playOptions: AdapterPlayOptions = {
        volume: this.getVolume(guildId),
        filters: this.getFilters(guildId),
      };

      await adapter.play(guildId, source, playOptions);
      this.emitQueueUpdate(guildId);
      return { skipped: true, nowPlaying: nextTrack };
    } catch (err) {
      this.logger.error(
        { err, guildId, track: nextTrack.name },
        '[PLAYBACK] Track failed: %s',
        nextTrack.name,
      );
      // Advance to next valid track
      await this.advanceQueue(guildId);
      return { skipped: true, nowPlaying: this.currentTracks.get(guildId) || null };
    }
  }

  pause(guildId: string): boolean {
    const adapter = this.ensureAdapter();
    return adapter.pause(guildId);
  }

  resume(guildId: string): boolean {
    const adapter = this.ensureAdapter();
    return adapter.resume(guildId);
  }

  stop(guildId: string): boolean {
    const adapter = this.ensureAdapter();
    this.endReasons.set(guildId, 'stopped');
    const stopped = adapter.stop(guildId);
    this.currentTracks.set(guildId, null);
    this.emitQueueUpdate(guildId);
    this.voiceLifecycleManager.handleQueueBecameEmpty(guildId);
    return stopped;
  }

  // ── Audio Controls & Effects ──────────────────────────────────────

  /**
   * Get guild volume (0 to 200, default 100).
   */
  getVolume(guildId: string): number {
    return this.guildVolumes.get(guildId) ?? 100;
  }

  /**
   * Set guild volume (clamped to 0-200) and update active audio stream immediately.
   */
  setVolume(guildId: string, volume: number): number {
    const clamped = Math.max(0, Math.min(200, Math.round(volume)));
    this.guildVolumes.set(guildId, clamped);

    if (this.adapter?.setVolume) {
      this.adapter.setVolume(guildId, clamped);
    }

    this.logger.info({ guildId, volume: clamped }, '[AUDIO] Volume changed: %d%', clamped);
    this.saveGuildSettings(guildId);
    this.emitSettingsUpdate(guildId);
    return clamped;
  }

  /**
   * Get current guild audio filter configuration.
   */
  getFilters(guildId: string): AudioFilterConfig {
    return (
      this.guildFilters.get(guildId) || {
        bassboost: false,
        speed: 1.0,
        nightcore: false,
      }
    );
  }

  /**
   * Toggle bassboost on or off and rebuild audio pipeline if currently playing.
   */
  async setBassboost(guildId: string, enabled: boolean): Promise<AudioFilterConfig> {
    const filters = { ...this.getFilters(guildId), bassboost: enabled };
    this.guildFilters.set(guildId, filters);

    this.logger.info({ guildId, bassboost: enabled }, '[AUDIO] Filter changed');

    const status = this.getPlaybackStatus(guildId);
    if ((status === 'PLAYING' || status === 'PAUSED') && this.adapter?.rebuildCurrentStream) {
      await this.adapter.rebuildCurrentStream(guildId, filters);
    }

    this.saveGuildSettings(guildId);
    this.emitSettingsUpdate(guildId);
    return filters;
  }

  /**
   * Set playback speed (0.5 to 2.0) and rebuild audio pipeline if currently playing.
   */
  async setSpeed(guildId: string, speed: number): Promise<AudioFilterConfig> {
    const clampedSpeed = Math.max(0.5, Math.min(2.0, Math.round(speed * 100) / 100));
    const filters = { ...this.getFilters(guildId), speed: clampedSpeed };
    this.guildFilters.set(guildId, filters);

    this.logger.info({ guildId, speed: clampedSpeed }, '[AUDIO] Filter changed');

    const status = this.getPlaybackStatus(guildId);
    if ((status === 'PLAYING' || status === 'PAUSED') && this.adapter?.rebuildCurrentStream) {
      await this.adapter.rebuildCurrentStream(guildId, filters);
    }

    this.saveGuildSettings(guildId);
    this.emitSettingsUpdate(guildId);
    return filters;
  }

  /**
   * Toggle nightcore mode on or off and rebuild audio pipeline if currently playing.
   */
  async setNightcore(guildId: string, enabled: boolean): Promise<AudioFilterConfig> {
    const filters = { ...this.getFilters(guildId), nightcore: enabled };
    this.guildFilters.set(guildId, filters);

    this.logger.info({ guildId, nightcore: enabled }, '[AUDIO] Filter changed');

    const status = this.getPlaybackStatus(guildId);
    if ((status === 'PLAYING' || status === 'PAUSED') && this.adapter?.rebuildCurrentStream) {
      await this.adapter.rebuildCurrentStream(guildId, filters);
    }

    this.saveGuildSettings(guildId);
    this.emitSettingsUpdate(guildId);
    return filters;
  }

  /**
   * Get guild loop mode ('off' | 'track' | 'queue').
   */
  getLoopMode(guildId: string): LoopMode {
    return this.guildLoopModes.get(guildId) || 'off';
  }

  /**
   * Set guild loop mode.
   */
  setLoopMode(guildId: string, mode: LoopMode): LoopMode {
    this.guildLoopModes.set(guildId, mode);
    this.logger.info({ guildId, loopMode: mode }, '[LOOP] Mode changed: %s', mode);
    this.saveGuildSettings(guildId);
    this.emitSettingsUpdate(guildId);
    return mode;
  }

  /**
   * Set stay-in-channel mode.
   */
  setStayInChannel(guildId: string, stay: boolean): boolean {
    this.voiceLifecycleManager.setStayInChannel(guildId, stay);
    this.saveGuildSettings(guildId);
    this.emitSettingsUpdate(guildId);
    return stay;
  }

  /**
   * Get stay-in-channel mode.
   */
  isStayInChannel(guildId: string): boolean {
    return this.voiceLifecycleManager.isStayInChannel(guildId);
  }

  /**
   * Set voice idle timeout seconds.
   */
  setTimeoutSeconds(guildId: string, seconds: number): number {
    this.voiceLifecycleManager.setTimeoutSeconds(guildId, seconds);
    this.saveGuildSettings(guildId);
    this.emitSettingsUpdate(guildId);
    return seconds;
  }

  /**
   * Get voice idle timeout seconds.
   */
  getTimeoutSeconds(guildId: string): number {
    return this.voiceLifecycleManager.getTimeoutSeconds(guildId);
  }

  // ── Queue Manipulation ────────────────────────────────────────────

  /**
   * Shuffle queued tracks for the current guild.
   */
  shuffleQueue(guildId: string): boolean {
    const shuffled = this.queueManager.shuffle(guildId);
    if (shuffled) {
      this.emitQueueUpdate(guildId);
    }
    return shuffled;
  }

  /**
   * Remove a track from the queue by its 1-based position.
   */
  removeQueueTrack(guildId: string, index: number): QueueTrack | null {
    const removed = this.queueManager.removeByIndex(guildId, index, true);
    if (removed) {
      this.emitQueueUpdate(guildId);
    }
    return removed;
  }

  /**
   * Clear all tracks from the queue without stopping the current track.
   */
  clearQueue(guildId: string): void {
    this.queueManager.clearQueue(guildId);
    this.emitQueueUpdate(guildId);
  }

  /**
   * Move a track from one position to another in the queue.
   */
  moveQueueTrack(guildId: string, fromIndex: number, toIndex: number): QueueTrack | null {
    const moved = this.queueManager.moveTrack(guildId, fromIndex, toIndex, true);
    if (moved) {
      this.emitQueueUpdate(guildId);
    }
    return moved;
  }

  // ── State Getters & Synchronization ───────────────────────────────

  getCurrentTrack(guildId: string): QueueTrack | null {
    return this.currentTracks.get(guildId) || null;
  }

  getPlaybackStatus(guildId: string): PlaybackStatus {
    return this.adapter ? this.adapter.getPlaybackStatus(guildId) : 'IDLE';
  }

  getState(guildId: string): VoicePlatformState {
    if (this.adapter) {
      return this.adapter.getState(guildId);
    }
    return {
      guildId,
      voiceState: 'DISCONNECTED',
      playerState: 'IDLE',
      track: null,
    };
  }

  /**
   * Get authoritative guild playback state representation.
   */
  getGuildState(guildId: string): GuildPlaybackState {
    const lifecycleState = this.voiceLifecycleManager.getOrCreateState(guildId);
    return {
      guildId,
      currentTrack: this.currentTracks.get(guildId) || null,
      volume: this.getVolume(guildId),
      filters: this.getFilters(guildId),
      loopMode: this.getLoopMode(guildId),
      stayInChannel: lifecycleState.stayInChannel,
      voiceIdleTimerActive: Boolean(lifecycleState.timer),
      voiceIdleReason: lifecycleState.timerReason,
      timeoutSeconds: lifecycleState.timeoutSeconds,
    };
  }

  getQueueEvent(guildId: string): QueueUpdatedEvent {
    const current = this.currentTracks.get(guildId) || null;
    return {
      guildId,
      currentTrack: current
        ? {
            id: current.id,
            name: current.name,
            artist: current.artist ?? null,
            album: current.album ?? null,
            thumbnailUrl: current.thumbnailUrl ?? null,
            sourceProvider: current.sourceProvider ?? null,
            duration: current.duration ?? null,
            source: current.source ?? current.sourceProvider ?? null,
            artwork: current.artwork ?? current.thumbnailUrl ?? null,
          }
        : null,
      queue: this.queueManager.getDisplayQueue(guildId),
      length: this.queueManager.getQueueLength(guildId),
    };
  }

  onQueueUpdate(listener: QueueUpdateListener): () => void {
    this.queueListeners.add(listener);
    return () => {
      this.queueListeners.delete(listener);
    };
  }

  onPlaybackSettingsUpdate(listener: SettingsUpdateListener): () => void {
    this.settingsListeners.add(listener);
    return () => {
      this.settingsListeners.delete(listener);
    };
  }

  onVoiceLifecycleUpdate(listener: LifecycleUpdateListener): () => void {
    this.lifecycleListeners.add(listener);
    return () => {
      this.lifecycleListeners.delete(listener);
    };
  }

  onStateChange(listener: StateChangeListener): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  onError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  private emitQueueUpdate(guildId: string): void {
    const event = this.getQueueEvent(guildId);
    for (const listener of this.queueListeners) {
      try {
        listener(event);
      } catch (err) {
        this.logger.error({ err, guildId }, 'Error in queue update listener');
      }
    }
  }

  private emitSettingsUpdate(guildId: string): void {
    const event: PlaybackSettingsUpdatedEvent = {
      type: 'playback.settings.updated',
      guildId,
      volume: this.getVolume(guildId),
      filters: this.getFilters(guildId),
      loopMode: this.getLoopMode(guildId),
      stayInChannel: this.isStayInChannel(guildId),
    };

    const guildEvent: GuildSettingsUpdatedEvent = {
      type: 'guild.settings.updated',
      guildId,
      settings: {
        guildId,
        volume: this.getVolume(guildId),
        filters: this.getFilters(guildId),
        loopMode: this.getLoopMode(guildId),
        stayInChannel: this.isStayInChannel(guildId),
        voiceIdleTimeout: this.voiceLifecycleManager.getTimeoutSeconds(guildId),
      },
    };

    for (const listener of this.settingsListeners) {
      try {
        listener(event);
        listener(guildEvent);
      } catch (err) {
        this.logger.error({ err, guildId }, 'Error in settings update listener');
      }
    }
  }

  private emitLifecycleUpdate(
    guildId: string,
    info: {
      humanCount: number;
      timerActive: boolean;
      reason: any;
      stayInChannel: boolean;
    },
  ): void {
    const event: VoiceLifecycleUpdatedEvent = {
      type: 'voice.lifecycle.updated',
      guildId,
      humanCount: info.humanCount,
      timerActive: info.timerActive,
      reason: info.reason,
      stayInChannel: info.stayInChannel,
    };

    for (const listener of this.lifecycleListeners) {
      try {
        listener(event);
      } catch (err) {
        this.logger.error({ err, guildId }, 'Error in lifecycle update listener');
      }
    }
  }
}
