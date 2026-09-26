import type { Logger } from 'pino';

/**
 * Manages audio playback across platforms.
 *
 * Responsible for:
 * - Coordinating play/pause/stop/skip commands
 * - Managing the audio pipeline (FFmpeg transcoding)
 * - Interfacing with platform adapters for voice output
 * - Volume control and audio effects
 *
 * Phase 1: Class skeleton only. The playback pipeline requires
 * @discordjs/voice and FFmpeg integration, planned for Phase 2.
 */
export class PlaybackManager {
  constructor(
    private readonly logger: Logger,
  ) {
    this.logger.debug('PlaybackManager initialized');
  }
}
