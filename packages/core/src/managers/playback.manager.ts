import type { Logger } from 'pino';
import { randomUUID } from 'node:crypto';
import type { AudioSource } from '../audio/audio-source';
import { LocalAudioSource } from '../audio/local-audio.source';
import { HttpAudioSource } from '../audio/http-audio.source';
import type { VoicePlatformAdapter, AdapterPlayOptions } from '../types/platform';
import type {
  VoicePlatformState,
  PlaybackStatus,
  PlaybackTarget,
  AudioRoutingState,
} from '../types/audio';
import { AudioRoutingManager } from './audio-routing.manager';
import { DesktopPlatformAdapter } from '../audio/desktop-platform.adapter';
import { DesktopAudioOutput } from '../audio/desktop-audio-output';
import { VirtualAudioOutput } from '../audio/virtual-audio-output';
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
import type { Readable } from 'node:stream';
import { QueueManager } from './queue.manager';
import { VoiceLifecycleManager } from './voice-lifecycle.manager';
import type { GuildSettingsManager } from './guild-settings.manager';
import type { AnalyticsManager } from './analytics.manager';
import type { TrackManager } from './track.manager';
import { TransitionEngine } from '../services/transition-engine';
import type { TransitionFeatureManager } from './transition-feature.manager';
import type { GuildTransitionSettings, TransitionPlan, FallbackLevel } from '../types/transition';
import { TransitionAudioSource } from '../audio/transition-audio.source';
import { LayeredTransitionEngine } from '../services/layered-transition-engine';
import type { StemManager } from './stem.manager';
import type { GuildStemSettings, LayeredTransitionPlan } from '../types/stem';

export interface TransitionAudioRenderer {
  renderTransitionStream(options: {
    fromSource: string;
    toSource: string;
    plan: TransitionPlan;
    seekFromSeconds?: number;
    seekToSeconds?: number;
  }): Promise<{ stream: Readable; process?: any; effectiveFallback: FallbackLevel }>;
}

type StateChangeListener = (state: VoicePlatformState) => void;
type QueueUpdateListener = (event: QueueUpdatedEvent) => void;
type SettingsUpdateListener = (event: PlaybackSettingsUpdatedEvent | GuildSettingsUpdatedEvent) => void;
type LifecycleUpdateListener = (event: VoiceLifecycleUpdatedEvent) => void;
type ErrorListener = (guildId: string, error: Error) => void;
type PlaybackEventListener = (event: any) => void;

interface GuildPlaybackSession {
  sessionId: string;
  currentEventId: string | null;
  trackId: string | null;
  startedAt: Date;
  activePlaybackSeconds: number;
  lastResumeTimestamp: number;
  isPaused: boolean;
}

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
 * - Records persistent playback history, active listening duration, and session metrics
 */
export class PlaybackManager {
  private adapter: VoicePlatformAdapter | null = null;
  private readonly adapters = new Map<string, VoicePlatformAdapter>();
  public readonly audioRoutingManager: AudioRoutingManager;
  private readonly routingListeners = new Set<(state: AudioRoutingState) => void>();
  private readonly currentTracks = new Map<string, QueueTrack | null>();
  private readonly endReasons = new Map<string, PlaybackEndReason>();
  private readonly isAdvancing = new Map<string, boolean>();

  // Authoritative guild audio & playback settings
  private readonly guildVolumes = new Map<string, number>();
  private readonly guildFilters = new Map<string, AudioFilterConfig>();
  private readonly guildLoopModes = new Map<string, LoopMode>();

  // Active playback sessions and event tracking
  private readonly sessions = new Map<string, GuildPlaybackSession>();

  public readonly voiceLifecycleManager: VoiceLifecycleManager;
  public readonly transitionEngine: TransitionEngine = new TransitionEngine();
  public readonly transitionFeatureManager?: TransitionFeatureManager;
  public readonly stemManager?: StemManager;
  public readonly layeredTransitionEngine: LayeredTransitionEngine = new LayeredTransitionEngine();
  private transitionRenderer: TransitionAudioRenderer | null = null;
  private readonly guildTransitions = new Map<string, GuildTransitionSettings>();
  private readonly guildStemSettings = new Map<string, GuildStemSettings>();
  private readonly preparedTransitions = new Map<string, { plan: TransitionPlan; nextTrack: QueueTrack; source: AudioSource }>();
  private readonly isPreparingTransition = new Map<string, boolean>();
  private lookaheadInterval: NodeJS.Timeout | null = null;
  private readonly transitionEventListeners = new Set<(event: any) => void>();

  private readonly stateListeners = new Set<StateChangeListener>();
  private readonly queueListeners = new Set<QueueUpdateListener>();
  private readonly settingsListeners = new Set<SettingsUpdateListener>();
  private readonly lifecycleListeners = new Set<LifecycleUpdateListener>();
  private readonly errorListeners = new Set<ErrorListener>();
  private readonly playbackEventListeners = new Set<PlaybackEventListener>();

  constructor(
    private readonly logger: Logger,
    public readonly queueManager: QueueManager,
    defaultTimeoutSeconds: number = 300,
    public readonly guildSettingsManager?: GuildSettingsManager,
    public readonly analyticsManager?: AnalyticsManager,
    public readonly trackManager?: TrackManager,
    transitionFeatureManager?: TransitionFeatureManager,
    stemManager?: StemManager,
  ) {
    this.logger.debug('PlaybackManager initialized');
    this.transitionFeatureManager = transitionFeatureManager;
    this.stemManager = stemManager;

    this.audioRoutingManager = new AudioRoutingManager();
    const desktopAdapter = new DesktopPlatformAdapter({
      desktopOutput: this.audioRoutingManager.getOutput('desktop') as DesktopAudioOutput,
      virtualOutput: this.audioRoutingManager.getOutput('virtual') as VirtualAudioOutput,
    });
    this.registerAdapter(desktopAdapter);

    this.audioRoutingManager.on('targetChanged', () => {
      this.getAudioRoutingState().then((s) => this.emitRoutingUpdate(s));
    });
    this.audioRoutingManager.on('outputDeviceChanged', () => {
      this.getAudioRoutingState().then((s) => this.emitRoutingUpdate(s));
    });
    this.audioRoutingManager.on('inputDeviceChanged', () => {
      this.getAudioRoutingState().then((s) => this.emitRoutingUpdate(s));
    });
    this.audioRoutingManager.on('deviceFallback', (failed, fallback, reason) => {
      this.logger.warn({ failed, fallback, reason }, '[ROUTING] Device fallback activated');
      this.getAudioRoutingState().then((s) => this.emitRoutingUpdate(s));
    });

    this.voiceLifecycleManager = new VoiceLifecycleManager(
      this.logger,
      {
        onAutoLeave: async (guildId, reason) => {
          // Double check if humans are present via voice adapter
          if (this.adapter?.getHumanCount) {
            const humans = this.adapter.getHumanCount(guildId);
            if (humans > 0) {
              this.logger.info(
                { guildId, humans },
                '[VOICE] Auto-leave prevented — humans are active in channel',
              );
              this.voiceLifecycleManager.handleHumanCountChange(guildId, humans);
              return;
            }
          }

          // If playback is currently playing, don't auto-disconnect
          if (this.adapter?.getPlaybackStatus && this.adapter.getPlaybackStatus(guildId) === 'PLAYING') {
            this.logger.info(
              { guildId },
              '[VOICE] Auto-leave prevented — audio is actively playing',
            );
            return;
          }

          this.logger.info(
            { guildId, reason },
            '[VOICE] Auto-leave triggered — disconnecting from voice channel',
          );
          try {
            await this.leave(guildId, { clearQueue: false });
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

    // Start background lookahead transition monitor
    this.lookaheadInterval = setInterval(() => {
      this.checkLookaheadTransitions().catch((err) => {
        this.logger.debug({ err }, 'Error in lookahead transition monitor');
      });
    }, 1000);
    this.lookaheadInterval.unref();

    // If persistent settings manager is provided, preload settings
    if (this.guildSettingsManager) {
      this.guildSettingsManager.loadAllSettings().then((allSettings) => {
        for (const [guildId, s] of allSettings) {
          this.guildVolumes.set(guildId, s.volume);
          this.guildFilters.set(guildId, s.filters);
          this.guildLoopModes.set(guildId, s.loopMode);
          this.voiceLifecycleManager.setStayInChannel(guildId, s.stayInChannel);
          this.voiceLifecycleManager.setTimeoutSeconds(guildId, s.voiceIdleTimeout);
          this.guildTransitions.set(guildId, {
            guildId,
            transitionEnabled: s.transitionEnabled ?? true,
            transitionDuration: s.transitionDuration ?? 6,
            transitionProfile: s.transitionProfile ?? 'BALANCED',
            harmonicMixing: s.harmonicMixing ?? true,
            autoTempo: s.autoTempo ?? true,
            loudnessNormalize: s.loudnessNormalize ?? true,
          });
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
    const t = this.getTransitionSettings(guildId);
    const settings: GuildSettings = {
      guildId,
      volume: this.getVolume(guildId),
      filters: this.getFilters(guildId),
      loopMode: this.getLoopMode(guildId),
      stayInChannel: this.isStayInChannel(guildId),
      voiceIdleTimeout: this.voiceLifecycleManager.getTimeoutSeconds(guildId),
      transitionEnabled: t.transitionEnabled,
      transitionDuration: t.transitionDuration,
      transitionProfile: t.transitionProfile,
      harmonicMixing: t.harmonicMixing,
      autoTempo: t.autoTempo,
      loudnessNormalize: t.loudnessNormalize,
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
    this.guildTransitions.set(guildId, {
      guildId,
      transitionEnabled: settings.transitionEnabled ?? true,
      transitionDuration: settings.transitionDuration ?? 6,
      transitionProfile: settings.transitionProfile ?? 'BALANCED',
      harmonicMixing: settings.harmonicMixing ?? true,
      autoTempo: settings.autoTempo ?? true,
      loudnessNormalize: settings.loudnessNormalize ?? true,
    });
    return settings;
  }

  /**
   * Register a voice platform adapter (e.g. DiscordVoiceAdapter).
   */
  registerAdapter(adapter: VoicePlatformAdapter): void {
    this.adapters.set(adapter.platform, adapter);
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
        await this.finalizePlaybackEvent(guildId, reason);

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

  getRegisteredAdapters(): string[] {
    return Array.from(this.adapters.keys());
  }

  getAdapterByPlatform(platform: string): VoicePlatformAdapter | undefined {
    return this.adapters.get(platform);
  }

  /**
   * Switch the active playback target (Discord <-> Desktop <-> Virtual Output).
   * Preserves current track, queue, volume, filters, and DJ state (Requirement 14).
   */
  async switchPlaybackTarget(target: PlaybackTarget): Promise<void> {
    const prevTarget = this.audioRoutingManager.getActiveTarget();
    if (prevTarget === target) return;

    this.logger.info({ from: prevTarget, to: target }, '[ROUTING] Switching playback target');
    await this.audioRoutingManager.switchTarget(target);

    const prevAdapter = this.adapter;
    let newAdapter: VoicePlatformAdapter | undefined;

    if (target === 'discord') {
      newAdapter = this.adapters.get('discord');
    } else {
      newAdapter = this.adapters.get('desktop');
    }

    if (!newAdapter) {
      this.logger.warn({ target }, 'No adapter registered for target, keeping existing adapter');
      return;
    }

    this.adapter = newAdapter;

    // Seamless handoff for any active playback sessions without destroying queue or state
    for (const [guildId, track] of this.currentTracks.entries()) {
      if (track) {
        const prevStatus = prevAdapter?.getPlaybackStatus(guildId);
        const duration = prevAdapter?.getPlaybackDuration ? prevAdapter.getPlaybackDuration(guildId) : 0;

        if (prevStatus === 'PLAYING') {
          prevAdapter?.pause(guildId);
          const source = this.createAudioSource(track);
          await this.adapter.play(guildId, source, {
            volume: this.getVolume(guildId),
            filters: this.getFilters(guildId),
            seekSeconds: duration,
          });
        }
      }
    }

    const state = await this.getAudioRoutingState();
    this.emitRoutingUpdate(state);
  }

  async getAudioRoutingState(): Promise<AudioRoutingState> {
    return this.audioRoutingManager.getState();
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    await this.audioRoutingManager.setOutputDevice(deviceId);
    const state = await this.getAudioRoutingState();
    this.emitRoutingUpdate(state);
  }

  async setInputDevice(deviceId: string): Promise<void> {
    await this.audioRoutingManager.setInputDevice(deviceId);
    const state = await this.getAudioRoutingState();
    this.emitRoutingUpdate(state);
  }

  setMonitoring(enabled: boolean, monitorDeviceId?: string): { success: boolean; error?: string } {
    const result = this.audioRoutingManager.setMonitoring(enabled, monitorDeviceId);
    if (result.success) {
      this.getAudioRoutingState().then((state) => this.emitRoutingUpdate(state));
    }
    return result;
  }

  onRoutingUpdate(listener: (state: AudioRoutingState) => void): () => void {
    this.routingListeners.add(listener);
    return () => {
      this.routingListeners.delete(listener);
    };
  }

  private emitRoutingUpdate(state: AudioRoutingState): void {
    for (const listener of this.routingListeners) {
      try {
        listener(state);
      } catch (err) {
        this.logger.error({ err }, 'Error in routing update listener');
      }
    }
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

  async leave(guildId: string, options: { clearQueue?: boolean } = { clearQueue: true }): Promise<void> {
    const adapter = this.ensureAdapter();
    this.endReasons.set(guildId, 'stopped');
    await this.finalizePlaybackEvent(guildId, 'stopped');
    this.sessions.delete(guildId);

    await adapter.leaveVoice(guildId);
    this.voiceLifecycleManager.setBotConnected(guildId, false);
    this.voiceLifecycleManager.cleanup(guildId);
    this.currentTracks.delete(guildId);
    this.preparedTransitions.delete(guildId);
    this.isPreparingTransition.delete(guildId);
    if (options.clearQueue !== false) {
      this.queueManager.clearQueue(guildId);
    }
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
      album?: string | null;
      thumbnailUrl?: string | null;
      sourceProvider?: string;
      sourceUrl?: string;
      source?: string | null;
      artwork?: string | null;
      addedBy?: string;
      userId?: string;
      trackId?: string;
    },
  ): Promise<{ status: 'started' | 'queued'; track: QueueTrack; position?: number }> {
    const adapter = this.ensureAdapter();
    const playerStatus = adapter.getPlaybackStatus(guildId);

    const track: QueueTrack = {
      id: randomUUID(),
      trackId: metadata.trackId,
      name: metadata.name,
      path: metadata.path,
      duration: metadata.duration,
      artist: metadata.artist,
      album: metadata.album,
      thumbnailUrl: metadata.thumbnailUrl,
      sourceProvider: metadata.sourceProvider,
      sourceUrl: metadata.sourceUrl,
      source: metadata.source,
      artwork: metadata.artwork,
      addedBy: metadata.addedBy,
      userId: metadata.userId,
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
    await this.startPlaybackEvent(guildId, track);

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
      await this.startPlaybackEvent(guildId, track);

      const playOptions: AdapterPlayOptions = {
        volume: this.getVolume(guildId),
        filters: this.getFilters(guildId),
      };

      await adapter.play(guildId, source, playOptions);
      this.emitQueueUpdate(guildId);
    } catch (err) {
      await this.finalizePlaybackEvent(guildId, 'error');
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
          await this.startPlaybackEvent(guildId, nextTrack);

          const playOptions: AdapterPlayOptions = {
            volume: this.getVolume(guildId),
            filters: this.getFilters(guildId),
          };

          await adapter.play(guildId, source, playOptions);
          this.emitQueueUpdate(guildId);
          return true;
        } catch (err) {
          await this.finalizePlaybackEvent(guildId, 'error');
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
    this.preparedTransitions.delete(guildId);
    this.isPreparingTransition.delete(guildId);
    await this.finalizePlaybackEvent(guildId, 'skipped');
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
      await this.startPlaybackEvent(guildId, nextTrack);

      const playOptions: AdapterPlayOptions = {
        volume: this.getVolume(guildId),
        filters: this.getFilters(guildId),
      };

      await adapter.play(guildId, source, playOptions);
      this.emitQueueUpdate(guildId);
      return { skipped: true, nowPlaying: nextTrack };
    } catch (err) {
      await this.finalizePlaybackEvent(guildId, 'error');
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
    const paused = adapter.pause(guildId);
    if (paused) {
      const session = this.sessions.get(guildId);
      if (session && !session.isPaused) {
        session.activePlaybackSeconds += (Date.now() - session.lastResumeTimestamp) / 1000;
        session.isPaused = true;
      }
    }
    return paused;
  }

  resume(guildId: string): boolean {
    const adapter = this.ensureAdapter();
    const resumed = adapter.resume(guildId);
    if (resumed) {
      const session = this.sessions.get(guildId);
      if (session && session.isPaused) {
        session.lastResumeTimestamp = Date.now();
        session.isPaused = false;
      }
    }
    return resumed;
  }

  stop(guildId: string): boolean {
    const adapter = this.ensureAdapter();
    this.endReasons.set(guildId, 'stopped');
    this.finalizePlaybackEvent(guildId, 'stopped').catch((err) => {
      this.logger.error({ err, guildId }, 'Error finalizing playback event on stop');
    });
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

  // ── Session & Analytics Event Helpers ──────────────────────────────

  /**
   * Get or initialize the lightweight session ID for a guild.
   */
  public getOrCreateSessionId(guildId: string): string {
    let session = this.sessions.get(guildId);
    if (!session) {
      const sessionId = 'session_' + randomUUID();
      session = {
        sessionId,
        currentEventId: null,
        trackId: null,
        startedAt: new Date(),
        activePlaybackSeconds: 0,
        lastResumeTimestamp: Date.now(),
        isPaused: false,
      };
      this.sessions.set(guildId, session);
    }
    return session.sessionId;
  }

  /**
   * Ensure track has a persistent PostgreSQL ID via TrackManager if available.
   */
  private async ensureTrackPersisted(track: QueueTrack): Promise<string> {
    if (track.trackId) return track.trackId;
    if (this.trackManager) {
      try {
        const saved = await this.trackManager.saveTrackWithSource(
          {
            title: track.name,
            artist: track.artist,
            album: track.album,
            duration: track.duration,
            thumbnailUrl: track.thumbnailUrl,
          },
          {
            provider: track.sourceProvider || 'local',
            sourceType: track.path.startsWith('http') ? 'stream' : 'file',
            sourceUrl: track.sourceUrl || track.path,
          },
        );
        track.trackId = saved.track.id;
        return saved.track.id;
      } catch (err) {
        this.logger.warn({ err, track: track.name }, 'Could not persist track metadata to database');
      }
    }
    const fallbackId = randomUUID();
    track.trackId = fallbackId;
    return fallbackId;
  }

  /**
   * Start a logical playback event for history and analytics.
   */
  private async startPlaybackEvent(guildId: string, track: QueueTrack): Promise<void> {
    // Finalize any dangling unfinalized event for this guild
    await this.finalizePlaybackEvent(guildId, 'stopped');

    const sessionId = this.getOrCreateSessionId(guildId);
    const persistentTrackId = await this.ensureTrackPersisted(track);
    const eventId = randomUUID();
    const now = new Date();

    this.sessions.set(guildId, {
      sessionId,
      currentEventId: eventId,
      trackId: persistentTrackId,
      startedAt: now,
      activePlaybackSeconds: 0,
      lastResumeTimestamp: Date.now(),
      isPaused: false,
    });

    if (this.analyticsManager) {
      try {
        await this.analyticsManager.recordPlaybackStart({
          eventId,
          guildId,
          trackId: persistentTrackId,
          userId: track.userId,
          source: track.sourceProvider || track.source,
          trackDuration: track.duration,
          sessionId,
          startedAt: now,
          trackTitle: track.name,
          artist: track.artist,
        });
      } catch (err) {
        this.logger.error({ err, eventId }, 'Failed to record playback start in AnalyticsManager');
      }
    }

    this.emitPlaybackEvent({
      type: 'playback.started',
      guildId,
      eventId,
      trackId: persistentTrackId,
      sessionId,
      title: track.name,
    });
  }

  /**
   * Finalize a playback event with accurate duration listened (excluding paused time).
   */
  private async finalizePlaybackEvent(guildId: string, endReason: PlaybackEndReason): Promise<void> {
    const session = this.sessions.get(guildId);
    if (!session || !session.currentEventId) return;

    if (!session.isPaused) {
      session.activePlaybackSeconds += (Date.now() - session.lastResumeTimestamp) / 1000;
    }

    const durationListened = Math.max(0, Math.round(session.activePlaybackSeconds));
    const completed = endReason === 'finished';
    const eventId = session.currentEventId;
    const trackId = session.trackId;
    session.currentEventId = null;

    if (this.analyticsManager) {
      try {
        await this.analyticsManager.recordPlaybackEnd(eventId, {
          endedAt: new Date(),
          durationListened,
          completed,
          endReason,
        });
      } catch (err) {
        this.logger.error({ err, eventId }, 'Failed to finalize playback event in AnalyticsManager');
      }
    }

    this.emitPlaybackEvent({
      type: 'playback.ended',
      guildId,
      eventId,
      trackId,
      endReason,
      completed,
      durationListened,
    });
  }

  onPlaybackEvent(listener: PlaybackEventListener): () => void {
    this.playbackEventListeners.add(listener);
    return () => {
      this.playbackEventListeners.delete(listener);
    };
  }

  private emitPlaybackEvent(event: any): void {
    for (const listener of this.playbackEventListeners) {
      try {
        listener(event);
      } catch (err) {
        this.logger.error({ err }, 'Error in playback event listener');
      }
    }
  }

  /**
   * Perform graceful shutdown of active playback sessions and queues.
   */
  async shutdown(): Promise<void> {
    this.logger.info('[PLAYBACK] Shutting down PlaybackManager, finalizing active events');
    if (this.lookaheadInterval) {
      clearInterval(this.lookaheadInterval);
      this.lookaheadInterval = null;
    }
    for (const [guildId, session] of this.sessions) {
      if (session.currentEventId) {
        await this.finalizePlaybackEvent(guildId, 'stopped');
      }
    }
  }

  // ── Phase 8: DJ Transitions & Lookahead Engine ────────────────────

  setTransitionRenderer(renderer: TransitionAudioRenderer): void {
    this.transitionRenderer = renderer;
    this.logger.info('TransitionAudioRenderer registered in PlaybackManager');
  }

  getTransitionSettings(guildId: string): GuildTransitionSettings {
    const existing = this.guildTransitions.get(guildId);
    if (existing) return existing;
    const defaults: GuildTransitionSettings = {
      guildId,
      transitionEnabled: true,
      transitionDuration: 6,
      transitionProfile: 'BALANCED',
      harmonicMixing: true,
      autoTempo: true,
      loudnessNormalize: true,
    };
    this.guildTransitions.set(guildId, defaults);
    return defaults;
  }

  setTransitionSettings(
    guildId: string,
    settings: Partial<GuildTransitionSettings>,
  ): GuildTransitionSettings {
    const current = this.getTransitionSettings(guildId);
    const updated: GuildTransitionSettings = {
      ...current,
      ...settings,
      transitionDuration:
        settings.transitionDuration !== undefined
          ? Math.max(1, Math.min(8, Math.round(settings.transitionDuration)))
          : current.transitionDuration,
    };
    this.guildTransitions.set(guildId, updated);
    this.saveGuildSettings(guildId);
    this.emitSettingsUpdate(guildId);
    return updated;
  }

  getStemSettings(guildId: string): GuildStemSettings {
    const existing = this.guildStemSettings.get(guildId);
    if (existing) return existing;
    const defaults: GuildStemSettings = {
      guildId,
      stemSeparationEnabled: true,
      vocalClashPrevention: true,
      vocalDucking: true,
      vocalDuckDb: 6.0,
      layeredTransitions: true,
      stemProviderPreference: 'auto',
    };
    this.guildStemSettings.set(guildId, defaults);
    return defaults;
  }

  setStemSettings(
    guildId: string,
    settings: Partial<GuildStemSettings>,
  ): GuildStemSettings {
    const current = this.getStemSettings(guildId);
    const updated: GuildStemSettings = {
      ...current,
      ...settings,
      vocalDuckDb:
        settings.vocalDuckDb !== undefined
          ? Math.max(3.0, Math.min(12.0, Math.round(settings.vocalDuckDb * 10) / 10))
          : current.vocalDuckDb,
    };
    this.guildStemSettings.set(guildId, updated);
    this.saveGuildSettings(guildId);
    this.emitSettingsUpdate(guildId);
    return updated;
  }

  onTransitionEvent(listener: (event: any) => void): () => void {
    this.transitionEventListeners.add(listener);
    return () => {
      this.transitionEventListeners.delete(listener);
    };
  }

  private emitTransitionEvent(event: any): void {
    for (const listener of this.transitionEventListeners) {
      try {
        listener(event);
      } catch (err) {
        this.logger.error({ err }, 'Error in transition event listener');
      }
    }
  }

  getPreparedTransition(
    guildId: string,
  ): { plan: TransitionPlan; nextTrack: QueueTrack } | null {
    const p = this.preparedTransitions.get(guildId);
    return p ? { plan: p.plan, nextTrack: p.nextTrack } : null;
  }

  /**
   * Lookahead preparation: Begin preparing the next track transition
   * 20-30 seconds before the current track reaches completion.
   */
  async prepareNextTrackTransition(
    guildId: string,
    force = false,
  ): Promise<TransitionPlan | null> {
    if (this.isPreparingTransition.get(guildId)) return null;
    if (this.preparedTransitions.has(guildId) && !force) {
      return this.preparedTransitions.get(guildId)!.plan;
    }

    const currentTrack = this.currentTracks.get(guildId);
    if (!currentTrack) return null;

    const tracksInQueue = this.queueManager.getOrCreateQueue(guildId).tracks;
    let nextTrack: QueueTrack | undefined = tracksInQueue[0];

    // Respect loop modes
    const loopMode = this.getLoopMode(guildId);
    if (loopMode === 'track') {
      // Loop track does not crossfade into itself
      return null;
    }
    if (!nextTrack && loopMode === 'queue') {
      nextTrack = currentTrack;
    }

    if (!nextTrack) return null;

    const settings = this.getTransitionSettings(guildId);
    if (!settings.transitionEnabled) return null;

    this.isPreparingTransition.set(guildId, true);

    const startTime = Date.now();
    this.emitTransitionEvent({
      type: 'transition.preparing',
      guildId,
      fromTrackId: currentTrack.trackId || currentTrack.id,
      toTrackId: nextTrack.trackId || nextTrack.id,
    });

    try {
      // Fetch transition features if available
      const fromFeatures = currentTrack.trackId && this.transitionFeatureManager
        ? await this.transitionFeatureManager.getFeatures(currentTrack.trackId)
        : null;
      const toFeatures = nextTrack.trackId && this.transitionFeatureManager
        ? await this.transitionFeatureManager.getFeatures(nextTrack.trackId)
        : null;

      const plan = this.transitionEngine.planTransition({
        guildId,
        fromTrackId: currentTrack.trackId || currentTrack.id,
        toTrackId: nextTrack.trackId || nextTrack.id,
        fromTrackDuration: currentTrack.duration || 180,
        toTrackDuration: nextTrack.duration || 180,
        fromFeatures,
        toFeatures,
        settings,
        rubberBandAvailable: true,
      });

      if (plan.fallbackLevel === 'HARD_CUT') {
        this.emitTransitionEvent({
          type: 'transition.fallback',
          guildId,
          plan,
          reason: plan.explanation,
        });
        return plan;
      }

      // Phase 9: Stem & Vocal Clash Analysis
      const stemSettings = this.getStemSettings(guildId);
      if (this.stemManager && stemSettings.stemSeparationEnabled) {
        try {
          const fromStems = currentTrack.trackId ? await this.stemManager.getStems(currentTrack.trackId) : null;
          const toStems = nextTrack.trackId ? await this.stemManager.getStems(nextTrack.trackId) : null;
          const fromVocal = currentTrack.trackId ? await this.stemManager.getVocalFeatures(currentTrack.trackId) : null;
          const toVocal = nextTrack.trackId ? await this.stemManager.getVocalFeatures(nextTrack.trackId) : null;

          const layeredPlan = this.layeredTransitionEngine.planTransition({
            guildId,
            fromTrackId: currentTrack.trackId || currentTrack.id,
            toTrackId: nextTrack.trackId || nextTrack.id,
            basePlan: plan,
            outgoingVocalFeatures: fromVocal,
            incomingVocalFeatures: toVocal,
            outgoingStems: fromStems?.stems,
            incomingStems: toStems?.stems,
            outgoingStemQuality: fromStems?.quality,
            incomingStemQuality: toStems?.quality,
            guildSettings: stemSettings,
          });

          this.emitTransitionEvent({
            type: 'transition.strategy.selected',
            guildId,
            fromTrackId: layeredPlan.fromTrackId,
            toTrackId: layeredPlan.toTrackId,
            strategy: layeredPlan.strategy,
            vocalClashScore: layeredPlan.vocalClashScore,
          });

          if (layeredPlan.vocalClashScore >= 0.3) {
            this.emitTransitionEvent({
              type: 'transition.vocal-clash.detected',
              guildId,
              clashScore: layeredPlan.vocalClashScore,
              strategy: layeredPlan.strategy,
            });
          }

          if (layeredPlan.strategy === 'VOCAL_DUCK') {
            this.emitTransitionEvent({
              type: 'transition.ducking.started',
              guildId,
              duckDb: layeredPlan.vocalDuckDb,
            });
          } else if (layeredPlan.strategy === 'INSTRUMENTAL_OUTRO_TO_VOCAL_INTRO') {
            this.emitTransitionEvent({
              type: 'transition.layered.started',
              guildId,
              strategy: layeredPlan.strategy,
            });
          }
        } catch (stemErr) {
          this.logger.warn({ err: stemErr, guildId }, '[DJ] Stem analysis skipped, falling back to base transition');
          this.emitTransitionEvent({
            type: 'transition.fallback',
            guildId,
            plan,
            reason: 'Stem processing unavailable, using Phase 8 crossfade',
          });
        }
      }

      if (this.transitionRenderer) {
        const source = new TransitionAudioSource(
          `transition:${currentTrack.id}:${nextTrack.id}`,
          {
            title: `${currentTrack.name} → ${nextTrack.name}`,
            artist: nextTrack.artist ?? null,
            album: nextTrack.album ?? null,
            duration: Math.round(nextTrack.duration ?? 0),
          },
          async () => {
            const res = await this.transitionRenderer!.renderTransitionStream({
              fromSource: currentTrack.path,
              toSource: nextTrack.path,
              plan,
              seekFromSeconds: plan.outgoingCueSeconds,
              seekToSeconds: plan.incomingCueSeconds,
            });
            return res.stream;
          },
        );

        this.preparedTransitions.set(guildId, {
          plan,
          nextTrack,
          source,
        });

        const prepDurationMs = Date.now() - startTime;
        this.logger.info(
          { guildId, planId: plan.id, prepDurationMs, score: plan.score },
          '[DJ] Transition prepared successfully',
        );

        this.emitTransitionEvent({
          type: 'transition.ready',
          guildId,
          fromTrackId: plan.fromTrackId,
          toTrackId: plan.toTrackId,
          durationMs: plan.durationSeconds * 1000,
          profile: plan.profile,
          score: plan.score,
          cueSeconds: plan.outgoingCueSeconds,
        });
      }

      return plan;
    } catch (err: any) {
      this.logger.error({ err, guildId }, '[DJ] Transition preparation failed');
      this.emitTransitionEvent({
        type: 'transition.failed',
        guildId,
        error: err.message,
      });
      return null;
    } finally {
      this.isPreparingTransition.delete(guildId);
    }
  }

  /**
   * Monitor active playback sessions to initiate transition preparation
   * and execute seamless handoff at the outgoing cue point.
   */
  private async checkLookaheadTransitions(): Promise<void> {
    if (!this.adapter) return;

    for (const [guildId, currentTrack] of this.currentTracks) {
      if (!currentTrack || !currentTrack.duration || currentTrack.duration < 10) {
        continue;
      }

      const status = this.adapter.getPlaybackStatus(guildId);
      if (status !== 'PLAYING') continue;

      const elapsedMs = this.adapter.getPlaybackDuration ? this.adapter.getPlaybackDuration(guildId) : 0;
      const elapsedSec = elapsedMs / 1000;
      const remainingSec = currentTrack.duration - elapsedSec;

      // 0. Stem Precomputation Lookahead (default 60s remaining): Pre-analyze upcoming track stems if missing
      const stemPrepThresholdSec = Number(process.env.DJ_STEM_PREPARE_SECONDS || 60);
      if (remainingSec <= stemPrepThresholdSec && this.stemManager) {
        const nextTrack = this.queueManager.getOrCreateQueue(guildId).tracks[0];
        if (nextTrack && (nextTrack.trackId || nextTrack.id)) {
          const trackId = nextTrack.trackId || nextTrack.id;
          this.stemManager.getStems(trackId).then((stems) => {
            if (!stems) {
              this.emitTransitionEvent({
                type: 'stem.analysis.started',
                guildId,
                trackId,
              });
            }
          }).catch(() => {});
        }
      }

      // 1. Lookahead Threshold (25s remaining): Trigger preparation if not already prepared
      const prepThresholdSec = 25;
      if (remainingSec <= prepThresholdSec && !this.preparedTransitions.has(guildId) && !this.isPreparingTransition.get(guildId)) {
        await this.prepareNextTrackTransition(guildId);
      }

      // 2. Outgoing Cue Point: Execute transition handoff
      const prepared = this.preparedTransitions.get(guildId);
      if (prepared && elapsedSec >= prepared.plan.outgoingCueSeconds) {
        this.logger.info(
          { guildId, elapsedSec, cue: prepared.plan.outgoingCueSeconds, nextTrack: prepared.nextTrack.name },
          '[DJ] Outgoing cue point reached — executing seamless transition handoff',
        );

        this.emitTransitionEvent({
          type: 'transition.started',
          guildId,
          fromTrackId: prepared.plan.fromTrackId,
          toTrackId: prepared.plan.toTrackId,
          durationMs: prepared.plan.durationSeconds * 1000,
          profile: prepared.plan.profile,
        });

        // Dequeue next track from queue
        const loopMode = this.getLoopMode(guildId);
        if (loopMode === 'queue') {
          this.queueManager.addTrack(guildId, currentTrack);
        }
        this.queueManager.getNext(guildId);

        // Handoff to transition stream
        this.currentTracks.set(guildId, prepared.nextTrack);
        this.preparedTransitions.delete(guildId);

        try {
          await this.adapter.play(guildId, prepared.source, {
            volume: this.getVolume(guildId),
          });

          this.emitTransitionEvent({
            type: 'transition.completed',
            guildId,
            toTrackId: prepared.plan.toTrackId,
          });

          this.emitQueueUpdate(guildId);
        } catch (err: any) {
          this.logger.error({ err, guildId }, '[DJ] Transition handoff failed, falling back to standard track playback');
          this.emitTransitionEvent({
            type: 'transition.failed',
            guildId,
            error: err.message,
          });
          await this.advanceQueue(guildId);
        }
      }
    }
  }
}
