import type { Logger } from 'pino';
import type { DatabaseClient } from '../database/connection';

/**
 * Manages track metadata and file storage.
 *
 * Responsible for:
 * - CRUD operations on track metadata in the database
 * - Resolving tracks from various audio sources
 * - Managing local file uploads and paths
 * - Track search and lookup
 *
 * Phase 1: Class skeleton only. CRUD operations will be implemented
 * alongside the audio source system and file upload API.
 */
export class TrackManager {
  constructor(
    private readonly db: DatabaseClient,
    private readonly logger: Logger,
  ) {
    this.logger.debug('TrackManager initialized');
  }
}
