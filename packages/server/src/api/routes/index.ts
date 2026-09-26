import { Router } from 'express';
import type { AudioPlayerManager } from '@gakki/core';
import { healthRoutes } from './health.routes';
import { playbackRoutes } from './playback.routes';

/**
 * Top-level API router.
 * All routes are mounted under /api by the server.
 */
export function createRoutes(playerManager?: AudioPlayerManager): Router {
  const router = Router();

  router.use('/health', healthRoutes());
  router.use('/playback', playbackRoutes(playerManager));

  return router;
}
