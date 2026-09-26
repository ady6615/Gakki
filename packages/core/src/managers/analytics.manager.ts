import type { Logger } from 'pino';
import type { DatabaseClient } from '../database/connection';

/**
 * Manages playback statistics and analytics.
 *
 * Responsible for:
 * - Recording playback events (what was played, when, how long)
 * - Generating listening statistics (most played, recent, etc.)
 * - Providing data for the AI recommendation engine
 *
 * Phase 1: Class skeleton only. Event recording will be implemented
 * alongside the playback pipeline.
 */
export class AnalyticsManager {
  constructor(
    private readonly db: DatabaseClient,
    private readonly logger: Logger,
  ) {
    this.logger.debug('AnalyticsManager initialized');
  }
}
