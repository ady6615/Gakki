import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import cors from 'cors';
import type {
  AudioPlayerManager,
  PlaybackManager,
  AudioSourceManager,
  AnalyticsManager,
  PlaylistManager,
  TrackManager,
  AiRecommendationManager,
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
  recManager?: AiRecommendationManager,
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
      recManager,
    ),
  );

  // Error handling (must be registered last for API routes)
  app.use(errorHandler);

  // ── Serve Web Dashboard (Vite build output) ───────────────────
  // Try multiple possible paths for the web dist (works with both tsx dev and compiled JS)
  const candidates = [
    path.resolve(process.cwd(), 'packages', 'web', 'dist'),
    path.resolve(__dirname, '..', '..', '..', '..', 'web', 'dist'),
    path.resolve(__dirname, '..', '..', '..', 'web', 'dist'),
  ];
  const webDistPath = candidates.find(p => fs.existsSync(path.join(p, 'index.html'))) || candidates[0];
  if (fs.existsSync(webDistPath)) {
    app.use(express.static(webDistPath));
    // SPA fallback: any non-API route serves index.html for client-side routing
    app.get('*', (_req, res) => {
      res.sendFile(path.join(webDistPath, 'index.html'));
    });
    logger.info({ webDistPath }, 'Serving web dashboard from static build');
  } else {
    app.get('/', (_req, res) => {
      res.json({ status: 'ok', message: 'Gakki API running. Web dashboard not built yet — run: npm run build -w @gakki/web' });
    });
    logger.warn({ webDistPath }, 'Web dashboard dist not found — dashboard will not be served');
  }

  const server = http.createServer(app);

  server.listen(port, () => {
    logger.info(`API server listening on http://localhost:${port}`);
  });

  return { app, server };
}
