import { Router } from 'express';
import { sql } from 'drizzle-orm';
import { getDatabase } from '@gakki/core';
import { isDiscordConnected } from '../../discord/bot';

/**
 * Health check endpoint.
 *
 * Reports the status of each subsystem so operators and the web UI
 * can verify the platform is functioning correctly.
 *
 * GET /api/health
 */
export function healthRoutes(): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    // Check database
    let dbStatus: 'connected' | 'disconnected' | 'error' = 'disconnected';
    try {
      const db = getDatabase();
      await db.execute(sql`SELECT 1`);
      dbStatus = 'connected';
    } catch (error) {
      if (error instanceof Error && error.message.includes('not initialized')) {
        dbStatus = 'disconnected';
      } else {
        dbStatus = 'error';
      }
    }

    // Check Discord
    const discordStatus: 'connected' | 'disconnected' = isDiscordConnected()
      ? 'connected'
      : 'disconnected';

    // Overall status
    const allHealthy = dbStatus === 'connected' && discordStatus === 'connected';
    const anyError = dbStatus === 'error';
    const status = allHealthy ? 'healthy' : anyError ? 'unhealthy' : 'degraded';

    res.json({
      status,
      timestamp: new Date().toISOString(),
      version: '0.1.0',
      services: {
        database: dbStatus,
        discord: discordStatus,
      },
    });
  });

  return router;
}
