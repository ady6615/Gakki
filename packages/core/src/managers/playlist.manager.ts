import type { Logger } from 'pino';
import type { DatabaseClient } from '../database/connection';

/**
 * Manages saved playlists.
 *
 * Responsible for:
 * - CRUD operations on playlists
 * - Adding/removing/reordering tracks within playlists
 * - Importing playlists from external sources
 *
 * Phase 1: Class skeleton only. Playlist CRUD will be implemented
 * alongside the track manager and API routes.
 */
export class PlaylistManager {
  constructor(
    private readonly db: DatabaseClient,
    private readonly logger: Logger,
  ) {
    this.logger.debug('PlaylistManager initialized');
  }
}
