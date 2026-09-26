import { Router } from 'express';
import { healthRoutes } from './health.routes';

/**
 * Top-level API router.
 * All routes are mounted under /api by the server.
 */
export function createRoutes(): Router {
  const router = Router();

  router.use('/health', healthRoutes());

  return router;
}
