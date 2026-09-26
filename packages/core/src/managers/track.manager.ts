import { eq, and, ilike, or } from 'drizzle-orm';
import type { DatabaseClient } from '../database/connection';
import * as schema from '../database/schema';
import type { TrackMetadata, TrackSourceInfo } from '../types/source';
import { createLogger } from '../utils/logger';

const logger = createLogger('track-manager');

export type TrackRow = typeof schema.tracks.$inferSelect;
export type TrackSourceRow = typeof schema.trackSources.$inferSelect;

/**
 * Manages persistent tracks and track sources in PostgreSQL.
 *
 * Separates tracks (conceptual entity with rich metadata)
 * from track sources (provider, URL, file, external ID).
 */
export class TrackManager {
  constructor(private readonly db: DatabaseClient | null = null) {
    logger.debug('TrackManager initialized');
  }

  /**
   * Save or find an existing track and associate it with a track source.
   */
  async saveTrackWithSource(
    metadata: TrackMetadata,
    source: TrackSourceInfo,
  ): Promise<{ track: TrackRow; source: TrackSourceRow }> {
    if (!this.db) {
      // In-memory mock row when running without database
      const dummyTrack: TrackRow = {
        id: '00000000-0000-0000-0000-000000000000',
        title: metadata.title,
        artist: metadata.artist ?? null,
        album: metadata.album ?? null,
        albumArtist: metadata.albumArtist ?? null,
        duration: metadata.duration ?? null,
        genre: metadata.genre ?? null,
        year: metadata.year ?? null,
        trackNumber: metadata.trackNumber ?? null,
        coverArt: metadata.coverArtPath ?? metadata.thumbnailUrl ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const dummySource: TrackSourceRow = {
        id: '00000000-0000-0000-0000-000000000001',
        trackId: dummyTrack.id,
        provider: source.provider,
        sourceType: source.sourceType,
        sourceUrl: source.sourceUrl,
        externalId: source.externalId ?? null,
        createdAt: new Date(),
        lastVerifiedAt: new Date(),
      };
      return { track: dummyTrack, source: dummySource };
    }

    try {
      // 1. Check if source already exists by (provider, sourceUrl) or (provider, externalId)
      let existingSource: TrackSourceRow | undefined;

      if (source.externalId) {
        const foundByExt = await this.db
          .select()
          .from(schema.trackSources)
          .where(
            and(
              eq(schema.trackSources.provider, source.provider),
              eq(schema.trackSources.externalId, source.externalId),
            ),
          )
          .limit(1);
        if (foundByExt.length > 0) {
          existingSource = foundByExt[0];
        }
      }

      if (!existingSource) {
        const foundByUrl = await this.db
          .select()
          .from(schema.trackSources)
          .where(
            and(
              eq(schema.trackSources.provider, source.provider),
              eq(schema.trackSources.sourceUrl, source.sourceUrl),
            ),
          )
          .limit(1);
        if (foundByUrl.length > 0) {
          existingSource = foundByUrl[0];
        }
      }

      if (existingSource) {
        // Update last_verified_at
        await this.db
          .update(schema.trackSources)
          .set({ lastVerifiedAt: new Date() })
          .where(eq(schema.trackSources.id, existingSource.id));

        const trackRows = await this.db
          .select()
          .from(schema.tracks)
          .where(eq(schema.tracks.id, existingSource.trackId))
          .limit(1);

        if (trackRows.length > 0) {
          return { track: trackRows[0], source: existingSource };
        }
      }

      // 2. Insert new track
      const insertedTracks = await this.db
        .insert(schema.tracks)
        .values({
          title: metadata.title,
          artist: metadata.artist ?? null,
          album: metadata.album ?? null,
          albumArtist: metadata.albumArtist ?? null,
          duration: metadata.duration ?? null,
          genre: metadata.genre ?? null,
          year: metadata.year ?? null,
          trackNumber: metadata.trackNumber ?? null,
          coverArt: metadata.coverArtPath ?? metadata.thumbnailUrl ?? null,
          updatedAt: new Date(),
        })
        .returning();

      const newTrack = insertedTracks[0];

      // 3. Insert new track source
      const insertedSources = await this.db
        .insert(schema.trackSources)
        .values({
          trackId: newTrack.id,
          provider: source.provider,
          sourceType: source.sourceType,
          sourceUrl: source.sourceUrl,
          externalId: source.externalId ?? null,
          lastVerifiedAt: new Date(),
        })
        .returning();

      const newSource = insertedSources[0];

      logger.info(
        { trackId: newTrack.id, title: newTrack.title, provider: source.provider },
        '[DB] Track and source persisted',
      );

      return { track: newTrack, source: newSource };
    } catch (err) {
      logger.error({ err, title: metadata.title, provider: source.provider }, 'Failed to persist track to database');
      throw err;
    }
  }

  /**
   * Search tracks in the database by title, artist, or album.
   */
  async search(query: string, limit: number = 10): Promise<TrackRow[]> {
    if (!this.db || !query.trim()) {
      return [];
    }

    try {
      const pattern = `%${query.trim()}%`;
      return await this.db
        .select()
        .from(schema.tracks)
        .where(
          or(
            ilike(schema.tracks.title, pattern),
            ilike(schema.tracks.artist, pattern),
            ilike(schema.tracks.album, pattern),
          ),
        )
        .limit(limit);
    } catch (err) {
      logger.error({ err, query }, 'Database track search failed');
      return [];
    }
  }
}
