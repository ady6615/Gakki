import type { Logger } from 'pino';
import { randomUUID } from 'node:crypto';
import type { AudioSource } from '../audio/audio-source';
import { LocalAudioSource } from '../audio/local-audio.source';
import type { VoicePlatformAdapter } from '../types/platform';
import type {
  VoicePlatformState,
  AudioTrackInfo,
  PlaybackStatus,
} from '../types/audio';
import type {
  QueueTrack,
  QueueDisplayItem,
  QueueUpdatedEvent,
  PlaybackEndReason,
} from '../types/queue';
import { QueueManager } from './queue.manager';

type StateChangeListener = (state: VoicePlatformState) => void;
type QueueUpdateListener = (event: QueueUpdatedEvent) => void;
type ErrorListener = (guildId: string, error: Error) => void;

/**
 * Manages audio playback coordination and queue advancement across platforms.
 *
 * Responsibilities:
 * - Coordinates play / pause / stop / skip / advance commands
 * - Interacts with QueueManager for FIFO queue operations
 * - Interacts with VoicePlatformAdapter (Discord, etc.) for voice output
 * - Distinguishes natural track completion from manual skip/stop
 * - Emits queue and playback state update events for WebSocket / API
 */
export class PlaybackManager {
  private adapter: VoicePlatformAdapter | null = null;
  private readonly currentTracks = new Map<string, QueueTrack | null>();
  private readonly endReasons = new Map<string, PlaybackEndReason>();
  private readonly isAdvancing = new Map<string, boolean>();

  private readonly stateListeners = new Set<StateChangeListener>();
  private readonly queueListeners = new Set<QueueUpdateListener>();
  private readonly errorListeners = new Set<ErrorListener>();

  constructor(
    private readonly logger: Logger,
    public readonly queueManager: QueueManager,
  ) {
    this.logger.debug('PlaybackManager initialized');

    // Forward queue changes to queue update listeners
    this.queueManager.onQueueChange((guildId) => {
      this.emitQueueUpdate(guildId);
    });
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
          await this.advanceQueue(guildId);
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
  }

  async leave(guildId: string): Promise<void> {
    const adapter = this.ensureAdapter();
    this.endReasons.set(guildId, 'stopped');
    await adapter.leaveVoice(guildId);
    this.currentTracks.delete(guildId);
    this.queueManager.clearQueue(guildId);
    this.emitQueueUpdate(guildId);
  }

  /**
   * Play a track or enqueue if a track is already playing.
   *
   * @param guildId - Target guild ID
   * @param source - Audio source
   * @param metadata - Track name, path, and optional info
   * @returns status: 'started' if playback started immediately, 'queued' if added to queue
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

    await adapter.play(guildId, source);
    this.emitQueueUpdate(guildId);
    return { status: 'started', track };
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
          const source = new LocalAudioSource(nextTrack.path);
          await source.validate();

          this.endReasons.set(guildId, 'finished');
          this.currentTracks.set(guildId, nextTrack);

          this.logger.info(
            { guildId, trackId: nextTrack.id, name: nextTrack.name },
            '[PLAYBACK] Track started: %s',
            nextTrack.name,
          );

          await adapter.play(guildId, source);
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

    // Dequeue next track directly
    const nextTrack = this.queueManager.getNext(guildId);
    if (!nextTrack) {
      this.currentTracks.set(guildId, null);
      this.emitQueueUpdate(guildId);
      return { skipped: true, nowPlaying: null };
    }

    this.logger.info(
      { guildId, trackId: nextTrack.id, name: nextTrack.name },
      '[PLAYBACK] Advancing queue: %s',
      nextTrack.name,
    );

    // Play next track
    try {
      const source = new LocalAudioSource(nextTrack.path);
      await source.validate();
      this.endReasons.set(guildId, 'finished');
      this.currentTracks.set(guildId, nextTrack);

      this.logger.info(
        { guildId, trackId: nextTrack.id, name: nextTrack.name },
        '[PLAYBACK] Track started: %s',
        nextTrack.name,
      );

      await adapter.play(guildId, source);
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
    return stopped;
  }

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

  getQueueEvent(guildId: string): QueueUpdatedEvent {
    const current = this.currentTracks.get(guildId) || null;
    return {
      guildId,
      currentTrack: current
        ? {
            id: current.id,
            name: current.name,
            duration: current.duration ?? null,
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
}
