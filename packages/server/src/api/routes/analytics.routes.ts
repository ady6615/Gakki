import { Router, type Request, type Response } from 'express';
import type { AnalyticsManager } from '@gakki/core';
import { createLogger } from '@gakki/core';

const logger = createLogger('analytics-routes');

export function analyticsRoutes(analyticsManager?: AnalyticsManager): Router {
  const router = Router();

  /**
   * GET /api/analytics/dashboard
   * Returns aggregated playback statistics across time ranges with user/guild isolation.
   */
  router.get('/dashboard', async (req: Request, res: Response) => {
    if (!analyticsManager) {
      return res.status(503).json({ error: 'Analytics service unavailable' });
    }

    try {
      const guildId = req.query.guildId as string | undefined;
      const userId = req.query.userId as string | undefined;
      const timeRange = (req.query.timeRange as 'today' | '7d' | '30d' | 'all') || '7d';

      const stats = await analyticsManager.getDashboardStats({
        guildId,
        userId,
        timeRange,
      });

      return res.json({ stats, ...stats });
    } catch (err: any) {
      logger.error({ err }, 'Failed to generate dashboard statistics');
      return res.status(500).json({ error: 'Failed to generate dashboard statistics' });
    }
  });

  /**
   * GET /api/analytics/overview
   */
  router.get('/overview', async (req: Request, res: Response) => {
    if (!analyticsManager) {
      return res.status(503).json({ error: 'Analytics service unavailable' });
    }

    try {
      const guildId = req.query.guildId as string | undefined;
      const timeRange = (req.query.timeRange as 'today' | '7d' | '30d' | 'all') || 'all';

      const stats = await analyticsManager.getDashboardStats({
        guildId,
        timeRange,
      });

      return res.json({ stats, ...stats });
    } catch (err: any) {
      logger.error({ err }, 'Failed to retrieve analytics overview');
      return res.status(500).json({ error: 'Failed to retrieve analytics overview' });
    }
  });

  return router;
}
