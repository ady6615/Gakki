import { Router } from 'express';
import type { AudioPlayerManager, PlaybackManager } from '@gakki/core';
import { healthRoutes } from './health.routes';
import { playbackRoutes } from './playback.routes';
import { queueRoutes } from './queue.routes';

/**
 * Top-level API router.
 * All routes are mounted under /api by the server.
 */
export function createRoutes(
  manager?: PlaybackManager | AudioPlayerManager,
): Router {
  const router = Router();

  const activePlaybackManager: PlaybackManager | undefined =
    manager && 'playbackManager' in manager
      ? (manager as AudioPlayerManager).playbackManager
      : (manager as PlaybackManager | undefined);

  router.use('/health', healthRoutes());
  router.use('/playback', playbackRoutes(manager as any));
  router.use('/queue', queueRoutes(activePlaybackManager));

  return router;
}
