import type {
  MusicSourceProvider,
  ResolvedTrack,
  TrackMetadata,
} from '@gakki/core';
import { createLogger } from '@gakki/core';
import { SpotifyParser, type SpotifyTrackMeta } from '../audio/spotify-parser';
import { YouTubeSourceProvider } from './youtube.provider';
import { ArtworkService } from '../services/artwork.service';

const logger = createLogger('spotify-provider');

export class SpotifySourceProvider implements MusicSourceProvider {
  readonly name = 'spotify';

  constructor(
    private readonly youtubeProvider: YouTubeSourceProvider,
    private readonly artworkService?: ArtworkService,
  ) {}

  canHandle(input: string): boolean {
    return SpotifyParser.isSpotifyUrl(input);
  }

  async getMetadata(input: string): Promise<TrackMetadata> {
    const meta = await SpotifyParser.getTrackMetadata(input);

    let coverArtPath: string | null = null;
    if (meta.thumbnailUrl && this.artworkService) {
      try {
        coverArtPath = await this.artworkService.cacheArtworkFromUrl(meta.thumbnailUrl);
      } catch {
        // ignore
      }
    }

    return {
      title: meta.title,
      artist: meta.artist,
      album: meta.album || 'Spotify',
      duration: meta.durationSec || null,
      thumbnailUrl: coverArtPath || meta.thumbnailUrl || null,
      coverArtPath,
    };
  }

  async resolve(input: string): Promise<ResolvedTrack> {
    logger.info({ input }, '[SPOTIFY] Resolving Spotify track via YouTube audio match');

    const meta = await SpotifyParser.getTrackMetadata(input);

    // Formulate a high-precision search query
    const searchQuery = `${meta.artist} - ${meta.title} audio`;
    const searchResults = await this.youtubeProvider.search(searchQuery, { limit: 3 });

    if (searchResults.length === 0) {
      // Fallback without "audio" keyword
      const fallbackResults = await this.youtubeProvider.search(`${meta.artist} ${meta.title}`, { limit: 1 });
      if (fallbackResults.length === 0) {
        throw new Error(`Could not find audio source on YouTube for Spotify track: "${meta.title}" by ${meta.artist}`);
      }
      searchResults.push(fallbackResults[0]);
    }

    const matchedVideo = searchResults[0];
    logger.info(
      { spotifyTitle: meta.title, ytTitle: matchedVideo.title, ytUrl: matchedVideo.sourceUrl },
      '[SPOTIFY] Matched Spotify track to YouTube video',
    );

    const resolvedYt = await this.youtubeProvider.resolve(matchedVideo.sourceUrl);

    let coverArtPath: string | null = null;
    if (meta.thumbnailUrl && this.artworkService) {
      try {
        coverArtPath = await this.artworkService.cacheArtworkFromUrl(meta.thumbnailUrl);
      } catch {
        // ignore
      }
    }

    return {
      title: meta.title,
      metadata: {
        title: meta.title,
        artist: meta.artist,
        album: meta.album || 'Spotify',
        duration: meta.durationSec || resolvedYt.metadata.duration || null,
        thumbnailUrl: coverArtPath || meta.thumbnailUrl || resolvedYt.metadata.thumbnailUrl || null,
        coverArtPath,
      },
      source: {
        provider: 'spotify',
        sourceType: 'stream',
        sourceUrl: meta.spotifyUrl,
        externalId: meta.spotifyId,
        isEphemeral: true,
      },
      streamUrlOrPath: resolvedYt.streamUrlOrPath,
      headers: resolvedYt.headers,
      isStream: true,
    };
  }
}
