import type { LyricsProvider, LyricsResult, TrackMetadataForLyrics } from '../../types/lyrics';
import { parseLrcLyrics } from '../../utils/lrc-parser';
import {
  computeLyricsMatchConfidence,
  cleanTrackMetadata,
  type CleanedTrackMetadata,
} from '../../utils/lyrics-matcher';
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
    this.timeoutMs = options?.timeoutMs || 5000;
  }

  async search(track: TrackMetadataForLyrics): Promise<LyricsResult | null> {
    if (!track.title || track.title.trim().length === 0) {
      return null;
    }

    const cleaned = cleanTrackMetadata(track);

    try {
      // 1. Try exact get if artist is present in cleaned metadata
      if (cleaned.artist) {
        const exactResult = await this.tryExactGet(cleaned, track);
        if (exactResult) {
          return exactResult;
        }
      }

      // 2. Try search API with cleaned metadata (q query)
      const searchResult = await this.trySearch(cleaned, track);
      if (searchResult) {
        return searchResult;
      }

      // 3. Fallback: if cleaned differed from raw title and didn't find anything, try raw title
      if (cleaned.title !== track.title) {
        const rawFallback: CleanedTrackMetadata = {
          title: track.title,
          artist: track.artist || undefined,
          album: track.album || undefined,
          duration: track.duration || undefined,
          searchQuery: [track.artist, track.title].filter(Boolean).join(' '),
        };
        const fallbackResult = await this.trySearch(rawFallback, track);
        if (fallbackResult) {
          return fallbackResult;
        }
      }

      return null;
    } catch (err: any) {
      logger.warn({ err: err?.message || String(err), title: track.title }, 'LRCLIB request failed');
      return null;
    }
  }

  private async tryExactGet(
    cleaned: CleanedTrackMetadata,
    rawTrack: TrackMetadataForLyrics
  ): Promise<LyricsResult | null> {
    if (!cleaned.artist) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const params = new URLSearchParams();
      params.set('track_name', cleaned.title);
      params.set('artist_name', cleaned.artist);

      const url = `${this.baseUrl}/get?${params.toString()}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'GakkiMusicBot/1.0 (https://github.com/ady6615/Gakki)' },
        signal: controller.signal,
      });

      if (!res.ok) {
        return null;
      }

      const data = (await res.json()) as LrcLibResponse;
      return this.formatResult(rawTrack, data);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async trySearch(
    cleaned: CleanedTrackMetadata,
    rawTrack: TrackMetadataForLyrics
  ): Promise<LyricsResult | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      // Broad 'q' search is the most forgiving for community lrclib queries
      const params = new URLSearchParams();
      params.set('q', cleaned.searchQuery || cleaned.title);

      const url = `${this.baseUrl}/search?${params.toString()}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'GakkiMusicBot/1.0 (https://github.com/ady6615/Gakki)' },
        signal: controller.signal,
      });

      if (!res.ok) {
        return null;
      }

      let items = (await res.json()) as LrcLibResponse[];
      if (!Array.isArray(items) || items.length === 0) {
        // Try track_name & artist_name search if q produced no results and artist exists
        if (cleaned.artist) {
          const fallbackParams = new URLSearchParams();
          fallbackParams.set('track_name', cleaned.title);
          fallbackParams.set('artist_name', cleaned.artist);

          const fallbackRes = await fetch(`${this.baseUrl}/search?${fallbackParams.toString()}`, {
            headers: { 'User-Agent': 'GakkiMusicBot/1.0 (https://github.com/ady6615/Gakki)' },
            signal: controller.signal,
          });

          if (fallbackRes.ok) {
            const fallbackItems = (await fallbackRes.json()) as LrcLibResponse[];
            if (Array.isArray(fallbackItems) && fallbackItems.length > 0) {
              items = fallbackItems;
            }
          }
        }
      }

      if (!Array.isArray(items) || items.length === 0) {
        return null;
      }

      // Find candidate with highest confidence score
      let bestItem: LrcLibResponse | null = null;
      let bestConfidence = 0;

      for (const item of items) {
        if (!item.plainLyrics && !item.syncedLyrics && !item.instrumental) continue;

        const candidate = {
          trackName: item.trackName || item.name || '',
          artistName: item.artistName,
          albumName: item.albumName,
          duration: item.duration,
        };

        const confCleaned = computeLyricsMatchConfidence(
          {
            title: cleaned.title,
            artist: cleaned.artist,
            album: cleaned.album,
            duration: cleaned.duration,
          },
          candidate
        );

        const confRaw = computeLyricsMatchConfidence(rawTrack, candidate);
        const confidence = Math.max(confCleaned, confRaw);

        if (confidence > bestConfidence) {
          bestConfidence = confidence;
          bestItem = item;
        }
      }

      // Reject if best match confidence is below 0.35
      if (!bestItem || bestConfidence < 0.35) {
        return null;
      }

      return this.formatResult(rawTrack, bestItem, bestConfidence);
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

    const cleaned = cleanTrackMetadata(track);
    const candidate = {
      trackName: data.trackName || data.name || track.title,
      artistName: data.artistName,
      albumName: data.albumName,
      duration: data.duration,
    };

    const confidence =
      explicitConfidence ??
      Math.max(
        computeLyricsMatchConfidence(
          {
            title: cleaned.title,
            artist: cleaned.artist,
            album: cleaned.album,
            duration: cleaned.duration,
          },
          candidate
        ),
        computeLyricsMatchConfidence(track, candidate)
      );

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
