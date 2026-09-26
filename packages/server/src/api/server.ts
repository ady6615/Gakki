import express from 'express';
import http from 'node:http';
import cors from 'cors';
import type { AudioPlayerManager, PlaybackManager } from '@gakki/core';
import { createLogger } from '@gakki/core';
import { createRoutes } from './routes';
import { errorHandler } from './middleware/error-handler';

const logger = createLogger('api');

/**
 * Create and start the Express HTTP server.
 *
 * Returns the raw http.Server so the WebSocket server can attach to it,
 * sharing the same port.
 */
export function createApiServer(
  port: number,
  manager?: PlaybackManager | AudioPlayerManager,
): { app: express.Application; server: http.Server } {
  const app = express();

  // Middleware
  app.use(cors());
  app.use(express.json());

  // Routes
  app.use('/api', createRoutes(manager));


  // Error handling (must be registered last)
  app.use(errorHandler);

  const server = http.createServer(app);

  server.listen(port, () => {
    logger.info(`API server listening on http://localhost:${port}`);
  });

  return { app, server };
}
