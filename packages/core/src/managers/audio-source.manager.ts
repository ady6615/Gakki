import type { Logger } from 'pino';

/**
 * Manages audio source adapters for fetching tracks from external services.
 *
 * Responsible for:
 * - Registering and routing to source-specific adapters (YouTube, Spotify, etc.)
 * - Resolving URLs/queries to playable audio streams
 * - Search across multiple sources
 *
 * Phase 1: Class skeleton only. Source adapters will be implemented
 * as individual modules that register with this manager.
 */
export class AudioSourceManager {
  constructor(
    private readonly logger: Logger,
  ) {
    this.logger.debug('AudioSourceManager initialized');
  }
}
