import { AudioSourceManager, type TrackManager } from '@gakki/core';
import { LocalSourceProvider } from './local-source.provider';
import { HttpStreamProvider } from './http-stream.provider';
import { SoundCloudSourceProvider } from './soundcloud.provider';
import { YouTubeSourceProvider } from './youtube.provider';
import { ArtworkService } from '../services/artwork.service';

export { LocalSourceProvider } from './local-source.provider';
export { HttpStreamProvider } from './http-stream.provider';
export { SoundCloudSourceProvider } from './soundcloud.provider';
export { YouTubeSourceProvider } from './youtube.provider';

/**
 * Factory function to create and configure a fully wired AudioSourceManager.
 */
export function createConfiguredAudioSourceManager(
  artworkService?: ArtworkService,
  trackManager?: TrackManager,
): AudioSourceManager {
  const manager = new AudioSourceManager(trackManager);
  const localProvider = new LocalSourceProvider(artworkService);

  // Register providers in resolution priority order:
  // 1. YouTube provider (policy-compliant interceptor)
  // 2. SoundCloud provider
  // 3. HTTP stream provider
  // 4. Local file provider
  manager.registerProvider(new YouTubeSourceProvider());
  manager.registerProvider(new SoundCloudSourceProvider(artworkService));
  manager.registerProvider(new HttpStreamProvider(artworkService));
  manager.registerProvider(localProvider);

  // Register search providers
  manager.registerSearchProvider(localProvider);

  return manager;
}
