import { AudioSourceManager, type TrackManager } from '@gakki/core';
import { LocalSourceProvider } from './local-source.provider';
import { HttpStreamProvider } from './http-stream.provider';
import { SoundCloudSourceProvider } from './soundcloud.provider';
import { YouTubeSourceProvider } from './youtube.provider';
import { SpotifySourceProvider } from './spotify.provider';
import { ArtworkService } from '../services/artwork.service';

export { LocalSourceProvider } from './local-source.provider';
export { HttpStreamProvider } from './http-stream.provider';
export { SoundCloudSourceProvider } from './soundcloud.provider';
export { YouTubeSourceProvider } from './youtube.provider';
export { SpotifySourceProvider } from './spotify.provider';

/**
 * Factory function to create and configure a fully wired AudioSourceManager.
 */
export function createConfiguredAudioSourceManager(
  artworkService?: ArtworkService,
  trackManager?: TrackManager,
): AudioSourceManager {
  const manager = new AudioSourceManager(trackManager);
  const localProvider = new LocalSourceProvider(artworkService);
  const youtubeProvider = new YouTubeSourceProvider(artworkService);
  const spotifyProvider = new SpotifySourceProvider(youtubeProvider, artworkService);

  // Register providers in resolution priority order:
  // 1. Spotify provider (resolves Spotify URLs via matched YouTube streams)
  // 2. YouTube provider (resolves YouTube & YouTube Music links / ytsearch:)
  // 3. SoundCloud provider
  // 4. HTTP stream provider
  // 5. Local file provider
  manager.registerProvider(spotifyProvider);
  manager.registerProvider(youtubeProvider);
  manager.registerProvider(new SoundCloudSourceProvider(artworkService));
  manager.registerProvider(new HttpStreamProvider(artworkService));
  manager.registerProvider(localProvider);

  // Register search providers (YouTube + Local)
  manager.registerSearchProvider(youtubeProvider);
  manager.registerSearchProvider(localProvider);

  return manager;
}
