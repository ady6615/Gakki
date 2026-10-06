import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  MusicSourceProvider,
  MusicSearchProvider,
  ResolvedTrack,
  TrackMetadata,
  SearchResult,
  SearchOptions,
} from '@gakki/core';
import { createLogger } from '@gakki/core';
import youtubedl from 'youtube-dl-exec';
import play from 'play-dl';
import ffmpegPath from 'ffmpeg-static';
import { ArtworkService } from '../services/artwork.service';

const logger = createLogger('youtube-provider');

export class ProviderPolicyRestrictionError extends Error {
  constructor(provider: string, policyNotice: string) {
    super(`[POLICY] Provider "${provider}" restriction: ${policyNotice}`);
    this.name = 'ProviderPolicyRestrictionError';
  }
}

/**
 * Builds optimized yt-dlp arguments with mobile/embedded client rotation
 * to reliably bypass YouTube's "Sign in to confirm you're not a bot" challenge.
 */
export function getYtDlpFlags(extra: Record<string, any> = {}): Record<string, any> {
  const flags: Record<string, any> = {
    noCheckCertificates: true,
    noWarnings: true,
    preferFreeFormats: true,
    extractorArgs: 'youtube:player_client=android,web,tv_embedded',
    addHeader: [
      'referer:youtube.com',
      'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    ],
    ...extra,
  };

  if (ffmpegPath && fs.existsSync(ffmpegPath)) {
    flags.ffmpegLocation = ffmpegPath;
  }

  // Support custom cookies file or browser cookies if configured
  if (process.env.YOUTUBE_COOKIES_PATH && fs.existsSync(process.env.YOUTUBE_COOKIES_PATH)) {
    flags.cookies = process.env.YOUTUBE_COOKIES_PATH;
  } else if (fs.existsSync(path.resolve(process.cwd(), 'cookies.txt'))) {
    flags.cookies = path.resolve(process.cwd(), 'cookies.txt');
  } else if (process.env.YOUTUBE_COOKIES_FROM_BROWSER) {
    flags.cookiesFromBrowser = process.env.YOUTUBE_COOKIES_FROM_BROWSER;
  }

  return flags;
}

export class YouTubeSourceProvider implements MusicSourceProvider, MusicSearchProvider {
  readonly name = 'youtube';

  constructor(private readonly artworkService?: ArtworkService) {}

  canHandle(input: string): boolean {
    const lower = input.toLowerCase().trim();
    return (
      lower.includes('youtube.com/watch') ||
      lower.includes('youtu.be/') ||
      lower.includes('music.youtube.com/watch') ||
      lower.startsWith('ytsearch:')
    );
  }

  /**
   * Search YouTube for videos matching query.
   */
  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const limit = options?.limit || 5;
    const cleanQuery = query.replace(/^ytsearch:/i, '').trim();

    try {
      const searchResults = await play.search(cleanQuery, {
        limit,
        source: { youtube: 'video' },
      });

      return searchResults.map((item) => ({
        title: item.title || 'Unknown Title',
        artist: item.channel?.name || 'YouTube',
        album: 'YouTube Music',
        duration: item.durationInSec || null,
        provider: this.name,
        sourceUrl: item.url,
        thumbnailUrl: item.thumbnails?.[0]?.url || null,
        externalId: item.id || null,
      }));
    } catch (err: any) {
      logger.warn({ err, query: cleanQuery }, '[YOUTUBE] Search failed');
      return [];
    }
  }

  /**
   * Extract video metadata.
   */
  async getMetadata(input: string): Promise<TrackMetadata> {
    let videoUrl = input;
    if (input.startsWith('ytsearch:')) {
      const results = await this.search(input, { limit: 1 });
      if (results.length === 0) {
        throw new Error(`No YouTube results found for query: ${input}`);
      }
      videoUrl = results[0].sourceUrl;
    }

    try {
      const output = (await youtubedl(
        videoUrl,
        getYtDlpFlags({ dumpSingleJson: true }),
      )) as any;

      let coverArtPath: string | null = null;
      const thumb = output.thumbnail;
      if (thumb && this.artworkService) {
        try {
          coverArtPath = await this.artworkService.cacheArtworkFromUrl(thumb);
        } catch {
          // ignore cache error
        }
      }

      return {
        title: output.title || 'YouTube Track',
        artist: output.uploader || output.channel || 'YouTube',
        album: output.album || 'YouTube Music',
        duration: output.duration || null,
        thumbnailUrl: coverArtPath || thumb || null,
        coverArtPath,
      };
    } catch (err: any) {
      logger.error({ err, videoUrl }, '[YOUTUBE] Failed to extract metadata');
      throw new Error(`Failed to fetch YouTube metadata: ${err.message}`);
    }
  }

  /**
   * Resolve a YouTube URL to a live direct stream for FFmpeg.
   */
  async resolve(input: string): Promise<ResolvedTrack> {
    let videoUrl = input;
    if (input.startsWith('ytsearch:')) {
      const results = await this.search(input, { limit: 1 });
      if (results.length === 0) {
        throw new Error(`No YouTube video found for query: ${input}`);
      }
      videoUrl = results[0].sourceUrl;
    }

    logger.info({ videoUrl }, '[YOUTUBE] Resolving direct audio stream');

    const output = (await youtubedl(
      videoUrl,
      getYtDlpFlags({ dumpSingleJson: true }),
    )) as any;

    if (!output) {
      throw new Error(`Could not extract video info for: ${videoUrl}`);
    }

    // Prioritize pure audio-only formats (e.g. format 251 Opus or 140 M4A), then combined audio streams
    const formats: any[] = output.formats || [];
    const pureAudioFormats = formats.filter(
      (f) => f.vcodec === 'none' && f.acodec !== 'none' && f.url,
    );
    pureAudioFormats.sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0));

    const anyAudioFormats = formats.filter((f) => f.acodec && f.acodec !== 'none' && f.url);
    anyAudioFormats.sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0));

    const selectedFormat =
      pureAudioFormats[0] || anyAudioFormats[0] || formats.find((f) => f.url);

    if (!selectedFormat || !selectedFormat.url) {
      throw new Error(`No playable audio format found for: ${videoUrl}`);
    }

    let coverArtPath: string | null = null;
    const thumb = output.thumbnail;
    if (thumb && this.artworkService) {
      try {
        coverArtPath = await this.artworkService.cacheArtworkFromUrl(thumb);
      } catch {
        // ignore
      }
    }

    const metadata: TrackMetadata = {
      title: output.title || 'YouTube Track',
      artist: output.uploader || output.channel || 'YouTube',
      album: output.album || 'YouTube Music',
      duration: output.duration || null,
      thumbnailUrl: coverArtPath || thumb || null,
      coverArtPath,
    };

    return {
      title: metadata.title,
      metadata,
      source: {
        provider: 'youtube',
        sourceType: 'stream',
        sourceUrl: videoUrl,
        externalId: output.id,
        isEphemeral: true,
      },
      streamUrlOrPath: selectedFormat.url,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Referer: 'https://www.youtube.com/',
      },
      isStream: true,
    };
  }
}
