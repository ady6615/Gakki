import { Router, type Request, type Response } from 'express';
import type { LyricsManager } from '@gakki/core';
import { createLogger } from '@gakki/core';

const logger = createLogger('lyrics-routes');

export function lyricsRoutes(lyricsManager?: LyricsManager): Router {
  const router = Router();

  /**
   * GET /api/lyrics
   * Resolves plain and synchronized lyrics for track by ID or query metadata.
   */
  router.get('/', async (req: Request, res: Response) => {
    if (!lyricsManager) {
      return res.status(503).json({ error: 'Lyrics service unavailable' });
    }

    try {
      const trackId = req.query.trackId as string | undefined;
      const title = (req.query.title as string | undefined)?.trim();
      const artist = (req.query.artist as string | undefined)?.trim();
      const album = (req.query.album as string | undefined)?.trim();
      const duration = req.query.duration ? parseFloat(req.query.duration as string) : undefined;

      if (!title && !trackId) {
        return res.status(400).json({ error: 'Either title or trackId is required' });
      }

      const result = await lyricsManager.getLyrics(
        {
          title: title || '',
          artist: artist || null,
          album: album || null,
          duration: duration || null,
        },
        trackId
      );

      if (!result) {
        return res.status(200).json({
          lyrics: null,
          message: 'Lyrics unavailable.',
        });
      }

      return res.json({ lyrics: result });
    } catch (err: any) {
      logger.error({ err }, 'Failed to resolve lyrics');
      return res.status(500).json({ error: 'Failed to resolve lyrics' });
    }
  });

  return router;
}
