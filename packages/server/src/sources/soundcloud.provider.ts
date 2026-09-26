import type {
  MusicSourceProvider,
  ResolvedTrack,
  TrackMetadata,
} from '@gakki/core';
import { createLogger } from '@gakki/core';
import { validateExternalUrl } from '../security/url-validator';
import { ArtworkService } from '../services/artwork.service';

const logger = createLogger('soundcloud-provider');

export class SoundCloudSourceProvider implements MusicSourceProvider {
  readonly name = 'soundcloud';

  constructor(private readonly artworkService?: ArtworkService) {}

  canHandle(input: string): boolean {
    const lower = input.toLowerCase();
    return lower.includes('soundcloud.com/');
  }

  async getMetadata(input: string): Promise<TrackMetadata> {
    validateExternalUrl(input);

    let title = 'SoundCloud Track';
    let artist: string | null = 'SoundCloud';
    let thumbnailUrl: string | null = null;
    let coverArtPath: string | null = null;

    try {
      const oembedUrl = `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(input)}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);

      const res = await fetch(oembedUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'GakkiMusicPlatform/1.0' },
      });
      clearTimeout(timer);

      if (res.ok) {
        const data = (await res.json()) as { title?: string; author_name?: string; thumbnail_url?: string };
        if (data.title) title = data.title;
        if (data.author_name) artist = data.author_name;
        if (data.thumbnail_url) {
          thumbnailUrl = data.thumbnail_url;
          if (this.artworkService) {
            coverArtPath = await this.artworkService.cacheArtworkFromUrl(data.thumbnail_url);
          }
        }
      }
    } catch (err) {
      logger.debug({ err, input }, 'Could not fetch SoundCloud oEmbed — using fallback metadata');
    }

    const metadata: TrackMetadata = {
      title,
      artist,
      album: 'SoundCloud',
      albumArtist: null,
      duration: null,
      genre: null,
      year: null,
      trackNumber: null,
      thumbnailUrl: coverArtPath || thumbnailUrl,
      coverArtPath,
    };

    logger.info({ url: input, title: metadata.title, artist: metadata.artist }, '[METADATA] Extracted: %s', metadata.title);
    return metadata;
  }

  async resolve(input: string): Promise<ResolvedTrack> {
    const metadata = await this.getMetadata(input);

    return {
      title: metadata.title,
      metadata,
      source: {
        provider: 'soundcloud',
        sourceType: 'url',
        sourceUrl: input,
        isEphemeral: true,
      },
      streamUrlOrPath: input,
      isStream: true,
    };
  }
}
