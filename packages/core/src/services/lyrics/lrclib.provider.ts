import type { LyricsProvider, LyricsResult, TrackMetadataForLyrics } from '../../types/lyrics';
import { parseLrcLyrics } from '../../utils/lrc-parser';
import { computeLyricsMatchConfidence } from '../../utils/lyrics-matcher';
import { createLogger } from '../../utils/logger';

const logger = createLogger('lrclib-lyrics-provider');

export interface LrcLibResponse {
  id?: number;
  name?: string;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string;
  syncedLyrics?: string;
}

export class LrcLibLyricsProvider implements LyricsProvider {
  readonly name = 'lrclib';
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options?: { baseUrl?: string; timeoutMs?: number }) {
    this.baseUrl = options?.baseUrl || 'https://lrclib.net/api';
    this.timeoutMs = options?.timeoutMs || 4000;
  }

  async search(track: TrackMetadataForLyrics): Promise<LyricsResult | null> {
    if (!track.title || track.title.trim().length === 0) {
      return null;
    }

    try {
      // 1. Try exact get if artist is present
      if (track.artist) {
        const exactResult = await this.tryExactGet(track);
        if (exactResult) {
          return exactResult;
        }
      }

      // 2. Fall back to search API
      return await this.trySearch(track);
    } catch (err: any) {
      logger.warn({ err: err?.message || String(err), title: track.title }, 'LRCLIB request failed');
      return null;
    }
  }

  private async tryExactGet(track: TrackMetadataForLyrics): Promise<LyricsResult | null> {
    const params = new URLSearchParams();
    params.set('track_name', track.title);
    if (track.artist) params.set('artist_name', track.artist);
    if (track.album) params.set('album_name', track.album);
    if (track.duration && track.duration > 0) params.set('duration', Math.round(track.duration).toString());

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const url = `${this.baseUrl}/get?${params.toString()}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'GakkiMusicBot/1.0 (https://github.com/ady6615/Gakki)' },
        signal: controller.signal,
      });

      if (!res.ok) {
        return null;
      }

      const data = (await res.json()) as LrcLibResponse;
      return this.formatResult(track, data);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async trySearch(track: TrackMetadataForLyrics): Promise<LyricsResult | null> {
    const params = new URLSearchParams();
    if (track.artist) {
      params.set('track_name', track.title);
      params.set('artist_name', track.artist);
    } else {
      params.set('q', track.title);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const url = `${this.baseUrl}/search?${params.toString()}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'GakkiMusicBot/1.0 (https://github.com/ady6615/Gakki)' },
        signal: controller.signal,
      });

      if (!res.ok) {
        return null;
      }

      const items = (await res.json()) as LrcLibResponse[];
      if (!Array.isArray(items) || items.length === 0) {
        return null;
      }

      // Find candidate with highest confidence score
      let bestItem: LrcLibResponse | null = null;
      let bestConfidence = 0;

      for (const item of items) {
        if (!item.plainLyrics && !item.syncedLyrics) continue;
        const confidence = computeLyricsMatchConfidence(track, {
          trackName: item.trackName || item.name || '',
          artistName: item.artistName,
          albumName: item.albumName,
          duration: item.duration,
        });

        if (confidence > bestConfidence) {
          bestConfidence = confidence;
          bestItem = item;
        }
      }

      // Reject if best match confidence is below 0.4
      if (!bestItem || bestConfidence < 0.4) {
        return null;
      }

      return this.formatResult(track, bestItem, bestConfidence);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private formatResult(
    track: TrackMetadataForLyrics,
    data: LrcLibResponse,
    explicitConfidence?: number
  ): LyricsResult | null {
    if (data.instrumental) {
      return {
        plainLyrics: '[Instrumental]',
        isSynced: false,
        providerName: this.name,
        sourceAttribution: 'LRCLIB (Community Lrc Database)',
        confidence: 0.95,
      };
    }

    const hasSynced = Boolean(data.syncedLyrics && data.syncedLyrics.trim().length > 0);
    const hasPlain = Boolean(data.plainLyrics && data.plainLyrics.trim().length > 0);

    if (!hasSynced && !hasPlain) {
      return null;
    }

    const parsedSynced = hasSynced ? parseLrcLyrics(data.syncedLyrics!) : undefined;
    const plain = hasPlain
      ? data.plainLyrics!
      : parsedSynced
      ? parsedSynced.map((l) => l.text).join('\n')
      : '';

    const confidence =
      explicitConfidence ??
      computeLyricsMatchConfidence(track, {
        trackName: data.trackName || data.name || track.title,
        artistName: data.artistName,
        albumName: data.albumName,
        duration: data.duration,
      });

    return {
      plainLyrics: plain.trim(),
      syncedLyrics: parsedSynced && parsedSynced.length > 0 ? parsedSynced : undefined,
      isSynced: Boolean(parsedSynced && parsedSynced.length > 0),
      providerName: this.name,
      sourceAttribution: 'LRCLIB (Community Lrc Database)',
      confidence,
    };
  }
}
