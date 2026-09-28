import type pg from 'pg';
import type { LibrarySearchResult, TrackDetails } from '../types/library';
import type { Track } from '../types/track';
import type { Playlist } from '../types/playlist';
import type { AudioFeatureManager } from './audio-feature.manager';
import type { AiRecommendationManager } from './ai-recommendation.manager';
import { createLogger } from '../utils/logger';

const logger = createLogger('library-manager');

export class LibraryManager {
  constructor(
    private readonly pool: pg.Pool,
    private readonly featureManager?: AudioFeatureManager,
    private readonly recManager?: AiRecommendationManager
  ) {}

  /**
   * Unified search across tracks, artists, albums, and playlists.
   * Parameterized SQL queries prevent injection and respect limits.
   */
  async search(
    query: string,
    options?: { limit?: number; offset?: number }
  ): Promise<LibrarySearchResult> {
    const q = (query || '').trim();
    if (!q) {
      return { tracks: [], artists: [], albums: [], playlists: [] };
    }

    const limit = Math.max(1, Math.min(50, options?.limit ?? 10));
    const offset = Math.max(0, options?.offset ?? 0);
    const likePattern = `%${q}%`;

    try {
      // 1. Search Tracks
      const tracksRes = await this.pool.query(
        `
        SELECT id, title, artist, album, duration, cover_art, created_at
        FROM tracks
        WHERE title ILIKE $1 OR artist ILIKE $1 OR album ILIKE $1
        ORDER BY
          CASE
            WHEN title ILIKE $2 THEN 1
            WHEN title ILIKE $1 THEN 2
            WHEN artist ILIKE $1 THEN 3
            ELSE 4
          END,
          title ASC
        LIMIT $3 OFFSET $4
        `,
        [likePattern, `${q}%`, limit, offset]
      );

      const tracks: Track[] = tracksRes.rows.map((r) => ({
        id: r.id,
        title: r.title,
        artist: r.artist,
        album: r.album,
        duration: r.duration,
        coverArt: r.cover_art,
        filePath: null,
        sourceType: 'local',
        sourceId: null,
        createdAt: r.created_at ? r.created_at.toISOString() : new Date().toISOString(),
      }));

      // 2. Search Artists (distinct with track counts)
      const artistsRes = await this.pool.query(
        `
        SELECT artist, COUNT(*) as track_count
        FROM tracks
        WHERE artist ILIKE $1 AND artist IS NOT NULL AND TRIM(artist) != ''
        GROUP BY artist
        ORDER BY track_count DESC, artist ASC
        LIMIT $2 OFFSET $3
        `,
        [likePattern, limit, offset]
      );

      const artists = artistsRes.rows.map((r) => ({
        name: r.artist,
        trackCount: parseInt(r.track_count, 10),
      }));

      // 3. Search Albums (distinct with artist and track count)
      const albumsRes = await this.pool.query(
        `
        SELECT album, artist, COUNT(*) as track_count
        FROM tracks
        WHERE album ILIKE $1 AND album IS NOT NULL AND TRIM(album) != ''
        GROUP BY album, artist
        ORDER BY track_count DESC, album ASC
        LIMIT $2 OFFSET $3
        `,
        [likePattern, limit, offset]
      );

      const albums = albumsRes.rows.map((r) => ({
        name: r.album,
        artist: r.artist,
        trackCount: parseInt(r.track_count, 10),
      }));

      // 4. Search Playlists
      const playlistsRes = await this.pool.query(
        `
        SELECT p.id, p.name, p.description, p.owner_user_id, p.guild_id,
               p.visibility, p.cover_art, p.is_favorite, p.created_at, p.updated_at,
               COUNT(pt.id) as track_count
        FROM playlists p
        LEFT JOIN playlist_tracks pt ON p.id = pt.playlist_id
        WHERE p.name ILIKE $1 OR (p.description IS NOT NULL AND p.description ILIKE $1)
        GROUP BY p.id
        ORDER BY p.name ASC
        LIMIT $2 OFFSET $3
        `,
        [likePattern, limit, offset]
      );

      const playlists: Playlist[] = playlistsRes.rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        ownerUserId: r.owner_user_id,
        guildId: r.guild_id,
        visibility: r.visibility || 'guild',
        trackCount: parseInt(r.track_count, 10),
        coverArt: r.cover_art,
        isFavorite: Boolean(r.is_favorite),
        createdAt: r.created_at ? r.created_at.toISOString() : new Date().toISOString(),
        updatedAt: r.updated_at ? r.updated_at.toISOString() : new Date().toISOString(),
      }));

      return {
        tracks,
        artists,
        albums,
        playlists,
      };
    } catch (err) {
      logger.error({ err, query: q }, 'Unified library search failed');
      return { tracks: [], artists: [], albums: [], playlists: [] };
    }
  }

  /**
   * Paginated track browsing. Supports both (options) and (limit, offset).
   */
  async getTracks(
    arg1?: { page?: number; limit?: number; artist?: string; album?: string } | number,
    arg2?: number
  ): Promise<{ tracks: Track[]; items: Track[]; total: number; page: number; limit: number }> {
    let limit = 25;
    let offset = 0;
    let page = 1;
    let artist: string | undefined;
    let album: string | undefined;

    if (typeof arg1 === 'number') {
      limit = Math.max(1, Math.min(100, arg1));
      offset = typeof arg2 === 'number' ? Math.max(0, arg2) : 0;
      page = Math.floor(offset / limit) + 1;
    } else if (arg1 && typeof arg1 === 'object') {
      page = Math.max(1, arg1.page ?? 1);
      limit = Math.max(1, Math.min(100, arg1.limit ?? 25));
      offset = (page - 1) * limit;
      artist = arg1.artist;
      album = arg1.album;
    }

    let whereClause = '';
    const params: any[] = [];

    if (artist) {
      params.push(artist);
      whereClause = `WHERE artist = $${params.length}`;
    } else if (album) {
      params.push(album);
      whereClause = `WHERE album = $${params.length}`;
    }

    const countRes = await this.pool.query(`SELECT COUNT(*) FROM tracks ${whereClause}`, params);
    const total = parseInt(countRes.rows[0].count, 10);

    const queryParams = [...params, limit, offset];
    const tracksRes = await this.pool.query(
      `
      SELECT id, title, artist, album, duration, cover_art, created_at
      FROM tracks
      ${whereClause}
      ORDER BY created_at DESC, title ASC
      LIMIT $${queryParams.length - 1} OFFSET $${queryParams.length}
      `,
      queryParams
    );

    const items: Track[] = tracksRes.rows.map((r) => ({
      id: r.id,
      title: r.title,
      artist: r.artist,
      album: r.album,
      duration: r.duration,
      coverArt: r.cover_art,
      filePath: null,
      sourceType: 'local',
      sourceId: null,
      createdAt: r.created_at ? r.created_at.toISOString() : new Date().toISOString(),
    }));

    return { tracks: items, items, total, page, limit };
  }

  /**
   * Paginated artists list with track counts.
   */
  async getArtists(options?: {
    page?: number;
    limit?: number;
  }): Promise<{ artists: { name: string; trackCount: number }[]; items: { name: string; trackCount: number }[]; total: number; page: number; limit: number }> {
    const page = Math.max(1, options?.page ?? 1);
    const limit = Math.max(1, Math.min(100, options?.limit ?? 25));
    const offset = (page - 1) * limit;

    const countRes = await this.pool.query(
      `SELECT COUNT(DISTINCT artist) FROM tracks WHERE artist IS NOT NULL AND TRIM(artist) != ''`
    );
    const total = parseInt(countRes.rows[0].count, 10);

    const res = await this.pool.query(
      `
      SELECT artist, COUNT(*) as track_count
      FROM tracks
      WHERE artist IS NOT NULL AND TRIM(artist) != ''
      GROUP BY artist
      ORDER BY artist ASC
      LIMIT $1 OFFSET $2
      `,
      [limit, offset]
    );

    const items = res.rows.map((r) => ({
      name: r.artist,
      trackCount: parseInt(r.track_count, 10),
    }));

    return { artists: items, items, total, page, limit };
  }

  /**
   * Paginated albums list with artist and track count.
   */
  async getAlbums(options?: {
    page?: number;
    limit?: number;
  }): Promise<{ items: { name: string; artist: string | null; trackCount: number }[]; albums: { name: string; artist: string | null; trackCount: number }[]; total: number; page: number; limit: number }> {
    const page = Math.max(1, options?.page ?? 1);
    const limit = Math.max(1, Math.min(100, options?.limit ?? 25));
    const offset = (page - 1) * limit;

    const countRes = await this.pool.query(
      `SELECT COUNT(DISTINCT album) FROM tracks WHERE album IS NOT NULL AND TRIM(album) != ''`
    );
    const total = parseInt(countRes.rows[0].count, 10);

    const res = await this.pool.query(
      `
      SELECT album, artist, COUNT(*) as track_count
      FROM tracks
      WHERE album IS NOT NULL AND TRIM(album) != ''
      GROUP BY album, artist
      ORDER BY album ASC
      LIMIT $1 OFFSET $2
      `,
      [limit, offset]
    );

    const items = res.rows.map((r) => ({
      name: r.album,
      artist: r.artist,
      trackCount: parseInt(r.track_count, 10),
    }));

    return { albums: items, items, total, page, limit };
  }

  /**
   * Detailed track view combining metadata, sources, audio features, analytics, and similar tracks.
   * Does NOT expose raw vector embeddings.
   */
  async getTrackDetails(trackId: string): Promise<TrackDetails | null> {
    if (!trackId) return null;

    try {
      // 1. Fetch track metadata
      const trackRes = await this.pool.query(
        `SELECT id, title, artist, album, duration, cover_art FROM tracks WHERE id = $1`,
        [trackId]
      );
      if (trackRes.rows.length === 0) return null;
      const t = trackRes.rows[0];

      // 2. Fetch track sources
      const sourcesRes = await this.pool.query(
        `SELECT provider, source_type, source_url FROM track_sources WHERE track_id = $1`,
        [trackId]
      );
      const sources = sourcesRes.rows.map((s) => ({
        provider: s.provider,
        sourceType: s.source_type,
        sourceUrl: s.source_url,
      }));

      // 3. Fetch acoustic features (sanitized without embedding)
      let audioFeatures: any = null;
      if (this.featureManager && typeof (this.featureManager as any).getFeatures === 'function') {
        const raw = await (this.featureManager as any).getFeatures(trackId);
        if (raw) {
          audioFeatures = {
            bpm: raw.bpm,
            key: raw.key,
            energy: raw.energy,
            spectralCentroid: raw.spectralCentroid,
            analysisStatus: raw.analysisStatus || 'READY',
          };
        }
      } else {
        const featRes = await this.pool.query(
          `SELECT bpm, key, energy, spectral_centroid, analysis_status FROM track_features WHERE track_id = $1`,
          [trackId]
        );
        if (featRes.rows.length > 0) {
          audioFeatures = featRes.rows[0];
        }
      }

      // 4. Fetch track playback analytics
      const analyticsRes = await this.pool.query(
        `
        SELECT
          COUNT(*) as play_count,
          COALESCE(SUM(duration_listened), 0) as total_listening_seconds,
          COUNT(*) FILTER (WHERE completed = TRUE) as completed_count,
          COUNT(*) FILTER (WHERE end_reason = 'skipped') as skip_count
        FROM playback_events
        WHERE track_id = $1
        `,
        [trackId]
      );

      const aRow = analyticsRes.rows[0];
      const playCount = parseInt(aRow.play_count, 10) || 0;
      const completedCount = parseInt(aRow.completed_count, 10) || 0;
      const skipCount = parseInt(aRow.skip_count, 10) || 0;
      const totalListeningSeconds = parseInt(aRow.total_listening_seconds, 10) || 0;
      const completionRate = playCount > 0 ? Math.round((completedCount / playCount) * 100) / 100 : 0;
      const skipRate = playCount > 0 ? Math.round((skipCount / playCount) * 100) / 100 : 0;

      // 5. Fetch similar tracks using existing Recommendation service
      let similarTracks: Track[] = [];
      if (this.recManager && typeof (this.recManager as any).getSimilarTracks === 'function') {
        try {
          const similarCandidates = await this.recManager.getSimilarTracks(trackId, 5);
          similarTracks = similarCandidates.map((c) => ({
            id: c.trackId,
            title: c.title,
            artist: c.artist,
            album: null,
            duration: c.features?.duration ?? null,
            coverArt: null,
            filePath: null,
            sourceType: 'local',
            sourceId: null,
            createdAt: new Date().toISOString(),
          }));
        } catch (err) {
          logger.warn({ err, trackId }, 'Failed to fetch similar tracks for track details');
        }
      }

      return {
        id: t.id,
        title: t.title,
        artist: t.artist,
        album: t.album,
        duration: t.duration,
        coverArt: t.cover_art,
        sources,
        audioFeatures: audioFeatures
          ? {
              ...audioFeatures,
              embedding: null, // do not expose raw embeddings
            }
          : null,
        analytics: {
          playCount,
          completionRate,
          skipRate,
          totalListeningSeconds,
        },
        similarTracks: similarTracks.length > 0 ? similarTracks : undefined,
      };
    } catch (err) {
      logger.error({ err, trackId }, 'Failed to retrieve track details');
      return null;
    }
  }
}
