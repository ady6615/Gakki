import { Router } from 'express';
import type {
  AudioPlayerManager,
  PlaybackManager,
  AudioSourceManager,
  AnalyticsManager,
  PlaylistManager,
  TrackManager,
  AiRecommendationManager,
  LyricsManager,
  FavoritesManager,
  LibraryManager,
  RecordingManager,
  TranscriptionManager,
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
import { lyricsRoutes } from './lyrics.routes';
import { favoritesRoutes } from './favorites.routes';
import { libraryRoutes } from './library.routes';
import { analyticsRoutes } from './analytics.routes';
import { recordingRoutes } from './recording.routes';
import { audioRoutingRoutes } from './audio-routing.routes';
import { ArtworkService } from '../../services/artwork.service';
import type { VoiceReceiverManager } from '../../voice';

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
  lyricsManager?: LyricsManager,
  favoritesManager?: FavoritesManager,
  libraryManager?: LibraryManager,
  recordingManager?: RecordingManager,
  transcriptionManager?: TranscriptionManager,
  voiceReceiver?: VoiceReceiverManager,
): Router {
  const router = Router();

  const activePlaybackManager: PlaybackManager | undefined =
    manager && 'playbackManager' in manager
      ? (manager as AudioPlayerManager).playbackManager
      : (manager as PlaybackManager | undefined);

  router.use('/health', healthRoutes());
  router.use('/playback', playbackRoutes(manager as any));
  router.use('/queue', queueRoutes(activePlaybackManager, audioSourceManager, trackManager));
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
  router.use('/lyrics', lyricsRoutes(lyricsManager));
  router.use('/favorites', favoritesRoutes(favoritesManager));
  router.use('/library', libraryRoutes(libraryManager));
  router.use('/analytics', analyticsRoutes(analyticsManager));
  router.use(
    '/recordings',
    recordingRoutes(recordingManager, transcriptionManager, voiceReceiver),
  );
  router.use('/audio', audioRoutingRoutes(activePlaybackManager));

  return router;
}
