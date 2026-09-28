import { Router, type Request, type Response } from 'express';
import type { FavoritesManager } from '@gakki/core';
import { createLogger } from '@gakki/core';

const logger = createLogger('favorites-routes');

export function favoritesRoutes(favoritesManager?: FavoritesManager): Router {
  const router = Router();

  /**
   * GET /api/favorites
   * List favorites for a specific user with pagination.
   */
  router.get('/', async (req: Request, res: Response) => {
    if (!favoritesManager) {
      return res.status(503).json({ error: 'Favorites service unavailable' });
    }

    const userId = req.query.userId as string;
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    try {
      const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;

      const result = await favoritesManager.getFavorites(userId, { page, limit });
      return res.json(result);
    } catch (err: any) {
      logger.error({ err, userId }, 'Failed to fetch favorites');
      return res.status(500).json({ error: 'Failed to fetch favorites' });
    }
  });

  /**
   * POST /api/favorites
   * Add a track to favorites.
   */
  router.post('/', async (req: Request, res: Response) => {
    if (!favoritesManager) {
      return res.status(503).json({ error: 'Favorites service unavailable' });
    }

    const { userId, trackId } = req.body;
    if (!userId || !trackId) {
      return res.status(400).json({ error: 'userId and trackId are required' });
    }

    try {
      const favorite = await favoritesManager.addFavorite(userId, trackId);
      return res.status(201).json({ favorite });
    } catch (err: any) {
      logger.error({ err, userId, trackId }, 'Failed to add favorite');
      return res.status(500).json({ error: 'Failed to add favorite' });
    }
  });

  /**
   * DELETE /api/favorites/:trackId
   * Remove a track from favorites.
   */
  router.delete('/:trackId', async (req: Request, res: Response) => {
    if (!favoritesManager) {
      return res.status(503).json({ error: 'Favorites service unavailable' });
    }

    const { trackId } = req.params;
    const userId = (req.query.userId as string) || req.body?.userId;

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    try {
      const removed = await favoritesManager.removeFavorite(userId, trackId);
      return res.json({ success: removed });
    } catch (err: any) {
      logger.error({ err, userId, trackId }, 'Failed to remove favorite');
      return res.status(500).json({ error: 'Failed to remove favorite' });
    }
  });

  /**
   * GET /api/favorites/check/:trackId
   * Check if user favorited track.
   */
  router.get('/check/:trackId', async (req: Request, res: Response) => {
    if (!favoritesManager) {
      return res.status(503).json({ error: 'Favorites service unavailable' });
    }

    const { trackId } = req.params;
    const userId = req.query.userId as string;

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    try {
      const isFav = await favoritesManager.isFavorite(userId, trackId);
      return res.json({ isFavorite: isFav });
    } catch (err: any) {
      logger.error({ err, userId, trackId }, 'Failed to check favorite');
      return res.status(500).json({ error: 'Failed to check favorite' });
    }
  });

  return router;
}
