import type { Logger } from 'pino';
import type { DatabaseClient } from '../database/connection';

/**
 * Manages playback queues for each guild/session.
 *
 * Responsible for:
 * - Adding/removing tracks from the queue
 * - Reordering queue items (drag-and-drop from web UI)
 * - Tracking the current playback position
 * - Queue persistence across bot restarts
 *
 * Phase 1: Class skeleton only. Queue operations will be implemented
 * when the playback pipeline and WebSocket sync are built.
 */
export class QueueManager {
  constructor(
    private readonly db: DatabaseClient,
    private readonly logger: Logger,
  ) {
    this.logger.debug('QueueManager initialized');
  }
}
