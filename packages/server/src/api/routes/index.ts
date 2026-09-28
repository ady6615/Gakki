import { Router } from 'express';
import type {
  AudioPlayerManager,
  PlaybackManager,
  AudioSourceManager,
  AnalyticsManager,
  PlaylistManager,
  TrackManager,
  AiRecommendationManager,
} from '@gakki/core';
import { healthRoutes } from './health.routes';
import { playbackRoutes } from './playback.routes';
import { queueRoutes } from './queue.routes';
import { artworkRoutes } from './artwork.routes';
import { sourceRoutes } from './source.routes';
import { historyRoutes } from './history.routes';
import { playlistRoutes } from './playlist.routes';
import { recommendationRoutes } from './recommendation.routes';
import { transitionRoutes } from './transition.routes';
import { stemRoutes } from './stem.routes';
import { ArtworkService } from '../../services/artwork.service';

/**
 * Top-level API router.
 * All routes are mounted under /api by the server.
 */
export function createRoutes(
  manager?: PlaybackManager | AudioPlayerManager,
  audioSourceManager?: AudioSourceManager,
  artworkService?: ArtworkService,
  analyticsManager?: AnalyticsManager,
  playlistManager?: PlaylistManager,
  trackManager?: TrackManager,
  recManager?: AiRecommendationManager,
): Router {
  const router = Router();

  const activePlaybackManager: PlaybackManager | undefined =
    manager && 'playbackManager' in manager
      ? (manager as AudioPlayerManager).playbackManager
      : (manager as PlaybackManager | undefined);

  router.use('/health', healthRoutes());
  router.use('/playback', playbackRoutes(manager as any));
  router.use('/queue', queueRoutes(activePlaybackManager));
  router.use('/artwork', artworkRoutes(artworkService));
  router.use('/sources', sourceRoutes(audioSourceManager));
  router.use('/history', historyRoutes(analyticsManager));
  router.use(
    '/playlists',
    playlistRoutes(playlistManager, activePlaybackManager, audioSourceManager, trackManager),
  );
  router.use('/recommendations', recommendationRoutes(recManager, activePlaybackManager));
  router.use('/guilds', transitionRoutes(activePlaybackManager));
  router.use('/stems', stemRoutes(activePlaybackManager, trackManager));

  return router;
}
