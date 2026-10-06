import { Router } from 'express';
import type { AudioSourceManager, TrackManager } from '@gakki/core';
import { globalRateLimiter } from '../../security/rate-limiter';
import { DownloaderService } from '../../audio/downloader.service';
import { YouTubeSourceProvider } from '../../sources/youtube.provider';
import { SpotifyParser } from '../../audio/spotify-parser';

/**
 * Endpoints for searching, resolving, and downloading music sources.
 */
export function sourceRoutes(
  audioSourceManager?: AudioSourceManager,
  trackManager?: TrackManager,
): Router {
  const router = Router();

  router.get('/search', async (req, res) => {
    const query = req.query.q as string;
    if (!query || !query.trim()) {
      res.status(400).json({ error: 'Query parameter "q" is required' });
      return;
    }

    const ip = req.ip || 'anonymous';
    const limit = globalRateLimiter.check(`user:${ip}`);
    if (!limit.allowed) {
      res.status(429).json({ error: 'Rate limit exceeded', retryAfterMs: limit.retryAfterMs });
      return;
    }

    if (!audioSourceManager) {
      res.status(503).json({ error: 'Audio source manager not initialized' });
      return;
    }

    try {
      const results = await audioSourceManager.search(query.trim(), { limit: 10 });
      res.json({ query: query.trim(), results });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Search failed' });
    }
  });

  router.post('/resolve', async (req, res) => {
    const { input } = req.body;
    if (!input || typeof input !== 'string') {
      res.status(400).json({ error: 'Body parameter "input" string is required' });
      return;
    }

    const ip = req.ip || 'anonymous';
    const limit = globalRateLimiter.check(`user:${ip}`);
    if (!limit.allowed) {
      res.status(429).json({ error: 'Rate limit exceeded', retryAfterMs: limit.retryAfterMs });
      return;
    }

    if (!audioSourceManager) {
      res.status(503).json({ error: 'Audio source manager not initialized' });
      return;
    }

    try {
      const resolved = await audioSourceManager.resolve(input.trim());
      res.json({
        title: resolved.title,
        metadata: resolved.metadata,
        source: {
          provider: resolved.source.provider,
          sourceType: resolved.source.sourceType,
          sourceUrl: resolved.source.sourceUrl,
        },
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Source resolution failed' });
    }
  });

  router.post('/download', async (req, res) => {
    const { input } = req.body;
    if (!input || typeof input !== 'string') {
      res.status(400).json({ error: 'Body parameter "input" string is required' });
      return;
    }

    const ip = req.ip || 'anonymous';
    const limit = globalRateLimiter.check(`user:${ip}`);
    if (!limit.allowed) {
      res.status(429).json({ error: 'Rate limit exceeded', retryAfterMs: limit.retryAfterMs });
      return;
    }

    const youtubeProvider =
      (audioSourceManager as any)?.providers?.get('youtube') || new YouTubeSourceProvider();
    const downloader = new DownloaderService(youtubeProvider, trackManager);

    try {
      const parsed = SpotifyParser.parseIdentifier(input);
      if (parsed && (parsed.type === 'playlist' || parsed.type === 'album')) {
        const results = await downloader.downloadCollection(input.trim());
        res.json({
          status: 'success',
          type: parsed.type,
          downloadedCount: results.length,
          tracks: results,
        });
      } else {
        const result = await downloader.downloadTrack(input.trim());
        res.json({
          status: 'success',
          track: result,
        });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Download failed' });
    }
  });

  return router;
}
