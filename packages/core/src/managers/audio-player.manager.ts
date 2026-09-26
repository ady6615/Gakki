import type { Logger } from 'pino';
import type { AudioSource } from '../audio/audio-source';
import type { VoicePlatformAdapter } from '../types/platform';
import type { VoicePlatformState } from '../types/audio';

type StateChangeListener = (state: VoicePlatformState) => void;
type ErrorListener = (guildId: string, error: Error) => void;

/**
 * Platform-agnostic Audio Player Manager.
 *
 * Coordinates playback commands across registered voice platform adapters.
 * Tracks per-guild voice and playback states, and dispatches state updates
 * to observers (API routes, WebSocket broadcasts, frontends).
 */
export class AudioPlayerManager {
  private adapter: VoicePlatformAdapter | null = null;
  private readonly stateListeners: Set<StateChangeListener> = new Set();
  private readonly errorListeners: Set<ErrorListener> = new Set();
  private readonly cachedStates: Map<string, VoicePlatformState> = new Map();

  constructor(private readonly logger: Logger) {
    this.logger.debug('AudioPlayerManager initialized');
  }

  /**
   * Register a voice platform adapter (e.g. DiscordVoiceAdapter).
   */
  registerAdapter(adapter: VoicePlatformAdapter): void {
    this.adapter = adapter;
    this.logger.info({ platform: adapter.platform }, 'Voice platform adapter registered');

    // Subscribe to adapter events
    adapter.onStateChange((state) => {
      this.cachedStates.set(state.guildId, state);
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
  }

  getAdapter(): VoicePlatformAdapter | null {
    return this.adapter;
  }

  private ensureAdapter(): VoicePlatformAdapter {
    if (!this.adapter) {
      throw new Error('No voice platform adapter registered in AudioPlayerManager');
    }
    return this.adapter;
  }

  async join(guildId: string, channelId: string, options?: unknown): Promise<void> {
    const adapter = this.ensureAdapter();
    await adapter.joinVoice(guildId, channelId, options);
  }

  async leave(guildId: string): Promise<void> {
    const adapter = this.ensureAdapter();
    await adapter.leaveVoice(guildId);
    this.cachedStates.delete(guildId);
  }

  async play(guildId: string, source: AudioSource): Promise<void> {
    const adapter = this.ensureAdapter();
    await adapter.play(guildId, source);
  }

  pause(guildId: string): boolean {
    const adapter = this.ensureAdapter();
    return adapter.pause(guildId);
  }

  resume(guildId: string): boolean {
    const adapter = this.ensureAdapter();
    return adapter.resume(guildId);
  }

  skip(guildId: string): boolean {
    // For Phase 2, skip stops the current track
    const adapter = this.ensureAdapter();
    return adapter.stop(guildId);
  }

  stop(guildId: string): boolean {
    const adapter = this.ensureAdapter();
    return adapter.stop(guildId);
  }

  getState(guildId: string): VoicePlatformState {
    if (this.adapter) {
      return this.adapter.getState(guildId);
    }
    return (
      this.cachedStates.get(guildId) || {
        guildId,
        voiceState: 'DISCONNECTED',
        playerState: 'IDLE',
        track: null,
      }
    );
  }

  getAllStates(): VoicePlatformState[] {
    const states: VoicePlatformState[] = [];
    for (const state of this.cachedStates.values()) {
      states.push(state);
    }
    return states;
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
}
