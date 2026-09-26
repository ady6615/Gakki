import * as path from 'node:path';
import type {
  MusicSourceProvider,
  ResolvedTrack,
  TrackMetadata,
} from '@gakki/core';
import { createLogger } from '@gakki/core';
import { validateExternalUrl } from '../security/url-validator';
import { ArtworkService } from '../services/artwork.service';

const logger = createLogger('http-stream-provider');

export class HttpStreamProvider implements MusicSourceProvider {
  readonly name = 'http_stream';

  constructor(private readonly artworkService?: ArtworkService) {}

  canHandle(input: string): boolean {
    if (!input.startsWith('http://') && !input.startsWith('https://')) {
      return false;
    }
    const lower = input.toLowerCase();
    // Exclude SoundCloud and YouTube domains which have dedicated or policy providers
    if (lower.includes('soundcloud.com') || lower.includes('youtube.com') || lower.includes('youtu.be')) {
      return false;
    }
    return true;
  }

  async getMetadata(input: string): Promise<TrackMetadata> {
    const parsed = validateExternalUrl(input);
    const pathname = parsed.pathname;
    const baseName = path.basename(pathname);
    const title = baseName && baseName !== '/' ? decodeURIComponent(baseName) : parsed.hostname;

    const metadata: TrackMetadata = {
      title,
      artist: parsed.hostname,
      album: 'Internet Stream',
      albumArtist: null,
      duration: null,
      genre: null,
      year: null,
      trackNumber: null,
      thumbnailUrl: null,
      coverArtPath: null,
    };

    logger.info({ url: input, title: metadata.title }, '[METADATA] Extracted: %s', metadata.title);
    return metadata;
  }

  async resolve(input: string): Promise<ResolvedTrack> {
    const metadata = await this.getMetadata(input);

    return {
      title: metadata.title,
      metadata,
      source: {
        provider: 'http_stream',
        sourceType: 'stream',
        sourceUrl: input,
        isEphemeral: true, // Ephemeral by default for remote live streams
      },
      streamUrlOrPath: input,
      isStream: true,
    };
  }
}
