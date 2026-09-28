import type pg from 'pg';
import type { UserFavorite, UserFavoritesPage } from '../types/favorite';
import { createLogger } from '../utils/logger';

const logger = createLogger('favorites-manager');

export class FavoritesManager {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Add a track to user's favorites. Idempotent (ON CONFLICT DO NOTHING).
   */
  async addFavorite(userId: string, trackId: string): Promise<UserFavorite> {
    if (!userId || !trackId) {
      throw new Error('userId and trackId are required to add a favorite');
    }

    const res = await this.pool.query(
      `
      INSERT INTO user_favorites (user_id, track_id, created_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (user_id, track_id) DO UPDATE SET created_at = user_favorites.created_at
      RETURNING user_id, track_id, created_at
      `,
      [userId, trackId]
    );

    const row = res.rows[0];

    // Fetch track details for return object
    const trackRes = await this.pool.query(
      `SELECT id, title, artist, album, duration, cover_art FROM tracks WHERE id = $1`,
      [trackId]
    );

    const trackRow = trackRes.rows[0];

    logger.info({ userId, trackId }, 'Track added to favorites');

    return {
      userId: row.user_id,
      trackId: row.track_id,
      createdAt: row.created_at.toISOString(),
      track: trackRow
        ? {
            id: trackRow.id,
            title: trackRow.title,
            artist: trackRow.artist,
            album: trackRow.album,
            duration: trackRow.duration,
            coverArt: trackRow.cover_art,
          }
        : undefined,
    };
  }

  /**
   * Remove a track from user's favorites.
   */
  async removeFavorite(userId: string, trackId: string): Promise<boolean> {
    if (!userId || !trackId) return false;

    const res = await this.pool.query(
      `DELETE FROM user_favorites WHERE user_id = $1 AND track_id = $2`,
      [userId, trackId]
    );

    const deleted = (res.rowCount ?? 0) > 0;
    if (deleted) {
      logger.info({ userId, trackId }, 'Track removed from favorites');
    }
    return deleted;
  }

  /**
   * Check whether a user has favorited a specific track.
   */
  async isFavorite(userId: string, trackId: string): Promise<boolean> {
    if (!userId || !trackId) return false;

    const res = await this.pool.query(
      `SELECT 1 FROM user_favorites WHERE user_id = $1 AND track_id = $2 LIMIT 1`,
      [userId, trackId]
    );
    return res.rows.length > 0;
  }

  /**
   * List user's favorites with pagination, ordered by latest added.
   */
  async getFavorites(
    userId: string,
    options?: { page?: number; limit?: number }
  ): Promise<UserFavoritesPage> {
    const page = Math.max(1, options?.page ?? 1);
    const limit = Math.max(1, Math.min(100, options?.limit ?? 20));
    const offset = (page - 1) * limit;

    const countRes = await this.pool.query(
      `SELECT COUNT(*) FROM user_favorites WHERE user_id = $1`,
      [userId]
    );
    const total = parseInt(countRes.rows[0].count, 10);

    const res = await this.pool.query(
      `
      SELECT uf.user_id, uf.track_id, uf.created_at,
             t.title, t.artist, t.album, t.duration, t.cover_art
      FROM user_favorites uf
      JOIN tracks t ON uf.track_id = t.id
      WHERE uf.user_id = $1
      ORDER BY uf.created_at DESC
      LIMIT $2 OFFSET $3
      `,
      [userId, limit, offset]
    );

    const items: UserFavorite[] = res.rows.map((r) => ({
      userId: r.user_id,
      trackId: r.track_id,
      createdAt: r.created_at.toISOString(),
      track: {
        id: r.track_id,
        title: r.title,
        artist: r.artist,
        album: r.album,
        duration: r.duration,
        coverArt: r.cover_art,
      },
    }));

    return {
      items,
      total,
      page,
      limit,
    };
  }
}
