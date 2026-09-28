import { Router, type Request, type Response } from 'express';
import type { LibraryManager } from '@gakki/core';
import { createLogger } from '@gakki/core';

const logger = createLogger('library-routes');

export function libraryRoutes(libraryManager?: LibraryManager): Router {
  const router = Router();

  /**
   * GET /api/library/search?q=...
   * Unified search across tracks, artists, albums, and playlists (Requirement 11).
   */
  router.get('/search', async (req: Request, res: Response) => {
    if (!libraryManager) {
      return res.status(503).json({ error: 'Library service unavailable' });
    }

    try {
      const q = (req.query.q as string) || '';
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 10;
      const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;

      const results = await libraryManager.search(q, { limit, offset });
      return res.json(results);
    } catch (err: any) {
      logger.error({ err }, 'Library search error');
      return res.status(500).json({ error: 'Failed to execute library search' });
    }
  });

  /**
   * GET /api/library/tracks
   * Paginated track browsing (Requirement 12).
   */
  router.get('/tracks', async (req: Request, res: Response) => {
    if (!libraryManager) {
      return res.status(503).json({ error: 'Library service unavailable' });
    }

    try {
      const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 25;
      const artist = req.query.artist as string | undefined;
      const album = req.query.album as string | undefined;

      const result = await libraryManager.getTracks({ page, limit, artist, album });
      return res.json(result);
    } catch (err: any) {
      logger.error({ err }, 'Failed to fetch library tracks');
      return res.status(500).json({ error: 'Failed to fetch library tracks' });
    }
  });

  /**
   * GET /api/library/tracks/:id
   * Detailed track view with features, analytics, and similar tracks (Requirement 13 & 14).
   */
  router.get('/tracks/:id', async (req: Request, res: Response) => {
    if (!libraryManager) {
      return res.status(503).json({ error: 'Library service unavailable' });
    }

    try {
      const { id } = req.params;
      const details = await libraryManager.getTrackDetails(id);

      if (!details) {
        return res.status(404).json({ error: 'Track not found' });
      }

      return res.json(details);
    } catch (err: any) {
      logger.error({ err, trackId: req.params.id }, 'Failed to fetch track details');
      return res.status(500).json({ error: 'Failed to fetch track details' });
    }
  });

  /**
   * GET /api/library/artists
   * Paginated artists list.
   */
  router.get('/artists', async (req: Request, res: Response) => {
    if (!libraryManager) {
      return res.status(503).json({ error: 'Library service unavailable' });
    }

    try {
      const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 25;

      const result = await libraryManager.getArtists({ page, limit });
      return res.json(result);
    } catch (err: any) {
      logger.error({ err }, 'Failed to fetch artists');
      return res.status(500).json({ error: 'Failed to fetch artists' });
    }
  });

  /**
   * GET /api/library/albums
   * Paginated albums list.
   */
  router.get('/albums', async (req: Request, res: Response) => {
    if (!libraryManager) {
      return res.status(503).json({ error: 'Library service unavailable' });
    }

    try {
      const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 25;

      const result = await libraryManager.getAlbums({ page, limit });
      return res.json(result);
    } catch (err: any) {
      logger.error({ err }, 'Failed to fetch albums');
      return res.status(500).json({ error: 'Failed to fetch albums' });
    }
  });

  return router;
}
