import { randomUUID } from 'node:crypto';
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
  private static readonly sharedTracks = new Map<string, TrackRow>();
  private static readonly sharedSources = new Map<string, TrackSourceRow>();

  private get inMemoryTracks() {
    return TrackManager.sharedTracks;
  }

  private get inMemorySources() {
    return TrackManager.sharedSources;
  }

  static getSharedTrackById(id: string): TrackRow | null {
    return TrackManager.sharedTracks.get(id) || null;
  }

  static getSharedSourceByTrackId(trackId: string): TrackSourceRow | null {
    for (const s of TrackManager.sharedSources.values()) {
      if (s.trackId === trackId) return s;
    }
    return null;
  }

  private readonly trackSavedListeners = new Set<(track: TrackRow, source: TrackSourceRow) => void>();

  constructor(private readonly db: DatabaseClient | null = null) {
    logger.debug('TrackManager initialized');
  }

  /**
   * Register listener for newly persisted or updated tracks.
   */
  onTrackSaved(listener: (track: TrackRow, source: TrackSourceRow) => void): () => void {
    this.trackSavedListeners.add(listener);
    return () => this.trackSavedListeners.delete(listener);
  }

  private emitTrackSaved(track: TrackRow, source: TrackSourceRow): void {
    for (const l of this.trackSavedListeners) {
      try {
        l(track, source);
      } catch (err) {
        logger.error({ err, trackId: track.id }, 'Error in onTrackSaved listener');
      }
    }
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
      const trackId = randomUUID();
      const dummyTrack: TrackRow = {
        id: trackId,
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
        id: randomUUID(),
        trackId: dummyTrack.id,
        provider: source.provider,
        sourceType: source.sourceType,
        sourceUrl: source.sourceUrl,
        externalId: source.externalId ?? null,
        createdAt: new Date(),
        lastVerifiedAt: new Date(),
      };
      this.inMemoryTracks.set(trackId, dummyTrack);
      this.inMemorySources.set(dummySource.id, dummySource);
      this.emitTrackSaved(dummyTrack, dummySource);
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

      this.emitTrackSaved(newTrack, newSource);
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
    if (!query.trim()) {
      return [];
    }

    if (!this.db) {
      const q = query.trim().toLowerCase();
      const results: TrackRow[] = [];
      for (const t of this.inMemoryTracks.values()) {
        if (
          t.title.toLowerCase().includes(q) ||
          (t.artist && t.artist.toLowerCase().includes(q)) ||
          (t.album && t.album.toLowerCase().includes(q))
        ) {
          results.push(t);
          if (results.length >= limit) break;
        }
      }
      return results;
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

  /**
   * Get track by ID.
   */
  async getTrackById(id: string): Promise<TrackRow | null> {
    if (!this.db) {
      return this.inMemoryTracks.get(id) || null;
    }

    try {
      const rows = await this.db
        .select()
        .from(schema.tracks)
        .where(eq(schema.tracks.id, id))
        .limit(1);
      return rows[0] || null;
    } catch (err) {
      logger.error({ err, id }, 'Database getTrackById failed');
      return null;
    }
  }

  /**
   * Get all tracks up to a limit.
   */
  async getAllTracks(limit: number = 100): Promise<TrackRow[]> {
    if (!this.db) {
      return Array.from(this.inMemoryTracks.values()).slice(0, limit);
    }

    try {
      return await this.db.select().from(schema.tracks).limit(limit);
    } catch (err) {
      logger.error({ err }, 'Database getAllTracks failed');
      return [];
    }
  }

  /**
   * Get primary source for a track.
   */
  async getPrimarySourceByTrackId(trackId: string): Promise<TrackSourceRow | null> {
    if (!this.db) {
      for (const s of this.inMemorySources.values()) {
        if (s.trackId === trackId) return s;
      }
      return null;
    }

    try {
      const rows = await this.db
        .select()
        .from(schema.trackSources)
        .where(eq(schema.trackSources.trackId, trackId))
        .limit(1);
      return rows[0] || null;
    } catch (err) {
      logger.error({ err, trackId }, 'Database getPrimarySourceByTrackId failed');
      return null;
    }
  }
}
