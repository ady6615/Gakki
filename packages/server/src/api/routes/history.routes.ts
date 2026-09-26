import { Router, type Request, type Response } from 'express';
import type { AnalyticsManager } from '@gakki/core';

export function historyRoutes(analyticsManager?: AnalyticsManager): Router {
  const router = Router();

  /**
   * GET /api/history
   * Get paginated playback history for a guild or user.
   */
  router.get('/', async (req: Request, res: Response) => {
    if (!analyticsManager) {
      res.json({ events: [], total: 0 });
      return;
    }

    try {
      const guildId = req.query.guildId as string | undefined;
      const userId = req.query.userId as string | undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
      const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;
      const completed = req.query.completed !== undefined ? req.query.completed === 'true' : undefined;
      const source = req.query.source as string | undefined;

      if (!guildId && !userId) {
        res.status(400).json({ error: 'Either guildId or userId must be provided' });
        return;
      }

      if (guildId) {
        const history = await analyticsManager.getGuildHistory(guildId, {
          limit,
          offset,
          completed,
          userId,
          source,
        });
        res.json(history);
      } else {
        const history = await analyticsManager.getUserHistory(userId!, {
          limit,
          offset,
        });
        res.json(history);
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to retrieve playback history' });
    }
  });

  /**
   * GET /api/history/recent
   * Get compact recently played tracks list for a guild.
   */
  router.get('/recent', async (req: Request, res: Response) => {
    if (!analyticsManager) {
      res.json([]);
      return;
    }

    try {
      const guildId = req.query.guildId as string;
      if (!guildId) {
        res.status(400).json({ error: 'guildId query parameter is required' });
        return;
      }

      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 10;
      const recent = await analyticsManager.getRecentTracks(guildId, limit);
      res.json(recent);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to retrieve recent tracks' });
    }
  });

  /**
   * GET /api/history/track/:trackId
   * Get aggregated play statistics for a specific track.
   */
  router.get('/track/:trackId', async (req: Request, res: Response) => {
    if (!analyticsManager) {
      res.status(404).json({ error: 'Analytics service unavailable' });
      return;
    }

    try {
      const { trackId } = req.params;
      const stats = await analyticsManager.getTrackStatistics(trackId);
      res.json(stats);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to retrieve track statistics' });
    }
  });

  /**
   * GET /api/history/analytics/:guildId
   * Get SQL-aggregated session analytics for a guild.
   */
  router.get('/analytics/:guildId', async (req: Request, res: Response) => {
    if (!analyticsManager) {
      res.json({
        guildId: req.params.guildId,
        totalTracksPlayed: 0,
        totalListeningTime: 0,
        completionRate: 0,
        skipRate: 0,
        uniqueUsers: 0,
        uniqueTracks: 0,
        topTracks: [],
        topArtists: [],
      });
      return;
    }

    try {
      const { guildId } = req.params;
      const analytics = await analyticsManager.getGuildAnalytics(guildId);
      res.json(analytics);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to retrieve guild analytics' });
    }
  });

  return router;
}
