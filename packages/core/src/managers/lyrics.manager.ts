import type pg from 'pg';
import type { LyricsProvider, LyricsResult, TrackMetadataForLyrics } from '../types/lyrics';
import { LyricsProviderRegistry } from '../services/lyrics/lyrics-provider.registry';
import { LrcLibLyricsProvider } from '../services/lyrics/lrclib.provider';
import { createLogger } from '../utils/logger';

const logger = createLogger('lyrics-manager');

export class LyricsManager {
  private readonly registry: LyricsProviderRegistry;
  private readonly pool?: pg.Pool;

  constructor(options?: { registry?: LyricsProviderRegistry; pool?: pg.Pool }) {
    this.registry = options?.registry || new LyricsProviderRegistry();
    this.pool = options?.pool;

    // Register default public provider if registry is empty
    if (this.registry.getProviders().length === 0) {
      this.registry.register(new LrcLibLyricsProvider());
    }
  }

  getRegistry(): LyricsProviderRegistry {
    return this.registry;
  }

  registerProvider(provider: LyricsProvider): void {
    this.registry.register(provider);
  }

  /**
   * Resolves lyrics for a track:
   * 1. Checks DB cache first (if pool provided and trackId given)
   * 2. Queries providers via registry
   * 3. Persists to DB cache if resolved with acceptable confidence
   */
  async getLyrics(
    track: TrackMetadataForLyrics,
    trackId?: string
  ): Promise<LyricsResult | null> {
    if (!track.title || track.title.trim().length === 0) {
      return null;
    }

    // 1. Check DB Cache
    if (this.pool && trackId) {
      try {
        const cached = await this.pool.query(
          `SELECT * FROM track_lyrics_cache WHERE track_id = $1 LIMIT 1`,
          [trackId]
        );
        if (cached.rows.length > 0) {
          const row = cached.rows[0];
          return {
            trackId,
            plainLyrics: row.plain_lyrics,
            syncedLyrics: row.synced_lyrics ? (typeof row.synced_lyrics === 'string' ? JSON.parse(row.synced_lyrics) : row.synced_lyrics) : undefined,
            isSynced: Boolean(row.is_synced),
            providerName: row.provider,
            sourceAttribution: row.attribution || undefined,
            confidence: Number(row.confidence) || 1.0,
            cachedAt: row.created_at,
          };
        }
      } catch (err) {
        logger.warn({ err }, 'Failed reading lyrics cache from database');
      }
    }

    // 2. Query provider registry
    const result = await this.registry.search(track);
    if (!result) {
      return null;
    }

    if (trackId) {
      result.trackId = trackId;
    }

    // 3. Persist to cache if high confidence
    if (this.pool && trackId && result.confidence >= 0.5) {
      this.persistCache(trackId, track, result).catch((err) => {
        logger.warn({ err, trackId }, 'Failed persisting lyrics to DB cache');
      });
    }

    return result;
  }

  private async persistCache(
    trackId: string,
    track: TrackMetadataForLyrics,
    result: LyricsResult
  ): Promise<void> {
    if (!this.pool) return;

    const syncedJson = result.syncedLyrics ? JSON.stringify(result.syncedLyrics) : null;
    await this.pool.query(
      `
      INSERT INTO track_lyrics_cache (
        track_id, artist, title, provider, plain_lyrics, synced_lyrics, is_synced, confidence, attribution, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      ON CONFLICT (track_id) DO UPDATE SET
        plain_lyrics = EXCLUDED.plain_lyrics,
        synced_lyrics = EXCLUDED.synced_lyrics,
        is_synced = EXCLUDED.is_synced,
        confidence = EXCLUDED.confidence,
        attribution = EXCLUDED.attribution,
        updated_at = NOW()
      `,
      [
        trackId,
        track.artist || null,
        track.title,
        result.providerName,
        result.plainLyrics,
        syncedJson,
        result.isSynced,
        result.confidence,
        result.sourceAttribution || null,
      ]
    );
  }

  /**
   * Formats lyrics text to fit safely within Discord message limits (2000 chars),
   * providing an excerpt with line preservation.
   */
  formatLyricsExcerpt(plainLyrics: string, maxLength: number = 1500): { excerpt: string; isTruncated: boolean } {
    if (!plainLyrics || plainLyrics.length <= maxLength) {
      return { excerpt: plainLyrics || '', isTruncated: false };
    }

    // Truncate cleanly at a newline boundary
    const sliced = plainLyrics.slice(0, maxLength);
    const lastNewline = sliced.lastIndexOf('\n');
    const cutPoint = lastNewline > 500 ? lastNewline : maxLength;

    const excerpt = sliced.slice(0, cutPoint).trim() + '\n\n... (Lyrics continue on Web Dashboard)';
    return { excerpt, isTruncated: true };
  }
}
