import type { Logger } from 'pino';
import type { AudioSource } from '../audio/audio-source';
import type { VoicePlatformAdapter } from '../types/platform';
import type { VoicePlatformState } from '../types/audio';
import type { QueueManager } from './queue.manager';
import { PlaybackManager } from './playback.manager';
import { QueueManager as DefaultQueueManager } from './queue.manager';

type StateChangeListener = (state: VoicePlatformState) => void;
type ErrorListener = (guildId: string, error: Error) => void;

/**
 * Audio Player Manager — bridges voice platform adapters with PlaybackManager.
 * Maintained for backward compatibility and high-level platform coordination.
 */
export class AudioPlayerManager {
  public readonly playbackManager: PlaybackManager;
  public readonly queueManager: QueueManager;

  constructor(private readonly logger: Logger, queueManager?: QueueManager) {
    this.logger.debug('AudioPlayerManager initialized');
    this.queueManager = queueManager || new DefaultQueueManager(logger);
    this.playbackManager = new PlaybackManager(logger, this.queueManager);
  }

  registerAdapter(adapter: VoicePlatformAdapter): void {
    this.playbackManager.registerAdapter(adapter);
  }

  getAdapter(): VoicePlatformAdapter | null {
    return this.playbackManager.getAdapter();
  }

  async join(guildId: string, channelId: string, options?: unknown): Promise<void> {
    await this.playbackManager.join(guildId, channelId, options);
  }

  async leave(guildId: string): Promise<void> {
    await this.playbackManager.leave(guildId);
  }

  async play(guildId: string, source: AudioSource): Promise<void> {
    await this.playbackManager.play(guildId, source, {
      name: source.identifier,
      path: source.identifier,
    });
  }

  pause(guildId: string): boolean {
    return this.playbackManager.pause(guildId);
  }

  resume(guildId: string): boolean {
    return this.playbackManager.resume(guildId);
  }

  skip(guildId: string): boolean {
    this.playbackManager.skip(guildId);
    return true;
  }

  stop(guildId: string): boolean {
    return this.playbackManager.stop(guildId);
  }

  getState(guildId: string): VoicePlatformState {
    return this.playbackManager.getState(guildId);
  }

  getAllStates(): VoicePlatformState[] {
    const adapter = this.playbackManager.getAdapter();
    if (!adapter) return [];
    // If state cached in playbackManager
    return [this.playbackManager.getState('')];
  }

  onStateChange(listener: StateChangeListener): () => void {
    return this.playbackManager.onStateChange(listener);
  }

  onError(listener: ErrorListener): () => void {
    return this.playbackManager.onError(listener);
  }
}
