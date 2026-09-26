import express from 'express';
import http from 'node:http';
import cors from 'cors';
import type {
  AudioPlayerManager,
  PlaybackManager,
  AudioSourceManager,
  AnalyticsManager,
  PlaylistManager,
  TrackManager,
} from '@gakki/core';
import { createLogger } from '@gakki/core';
import { createRoutes } from './routes';
import { errorHandler } from './middleware/error-handler';
import { ArtworkService } from '../services/artwork.service';

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
  audioSourceManager?: AudioSourceManager,
  artworkService?: ArtworkService,
  analyticsManager?: AnalyticsManager,
  playlistManager?: PlaylistManager,
  trackManager?: TrackManager,
): { app: express.Application; server: http.Server } {
  const app = express();

  // Middleware
  app.use(cors());
  app.use(express.json());

  // Routes
  app.use(
    '/api',
    createRoutes(
      manager,
      audioSourceManager,
      artworkService,
      analyticsManager,
      playlistManager,
      trackManager,
    ),
  );

  // Error handling (must be registered last)
  app.use(errorHandler);

  const server = http.createServer(app);

  server.listen(port, () => {
    logger.info(`API server listening on http://localhost:${port}`);
  });

  return { app, server };
}
