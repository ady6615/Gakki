/**
 * Phase 9: Stem Separation & Vocal Mixing API Routes
 *
 * Implements REST API endpoints for:
 * - GET /api/stems/capabilities
 * - GET /api/stems/guilds/:guildId/settings
 * - POST /api/stems/guilds/:guildId/settings
 * - GET /api/stems/tracks/:trackId
 * - POST /api/stems/tracks/:trackId/analyze
 * - GET /api/stems/jobs/:jobId
 */

import { Router, Request, Response } from 'express';
import type { PlaybackManager, TrackManager } from '@gakki/core';
import { StemProviderRegistry } from '../../audio/stems/stem-provider.registry';
import { StemWorkerPool } from '../../audio/stems/stem-worker-pool';
import { createLogger } from '@gakki/core';

const logger = createLogger('stem-routes');

export function stemRoutes(
  playbackManager?: PlaybackManager,
  trackManager?: TrackManager,
): Router {
  const router = Router();
  const registry = StemProviderRegistry.getInstance();

  /**
   * GET /api/stems/capabilities
   * Returns available stem separation providers and hardware backends.
   */
  router.get('/capabilities', async (_req: Request, res: Response) => {
    try {
      const caps = await registry.discoverCapabilities();
      res.json({
        success: true,
        capabilities: caps,
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /api/stems/guilds/:guildId/settings
   * Returns guild stem settings.
   */
  router.get('/guilds/:guildId/settings', (req: Request, res: Response) => {
    const { guildId } = req.params;
    if (!playbackManager) {
      return res.status(503).json({ error: 'PlaybackManager not available' });
    }

    const settings = playbackManager.getStemSettings(guildId);
    res.json({
      success: true,
      guildId,
      settings,
    });
  });

  /**
   * POST /api/stems/guilds/:guildId/settings
   * Updates guild stem settings.
   */
  router.post('/guilds/:guildId/settings', (req: Request, res: Response) => {
    const { guildId } = req.params;
    if (!playbackManager) {
      return res.status(503).json({ error: 'PlaybackManager not available' });
    }

    const body = req.body || {};
    const updated = playbackManager.setStemSettings(guildId, {
      stemSeparationEnabled:
        body.stemSeparationEnabled !== undefined ? Boolean(body.stemSeparationEnabled) : undefined,
      vocalClashPrevention:
        body.vocalClashPrevention !== undefined ? Boolean(body.vocalClashPrevention) : undefined,
      vocalDucking: body.vocalDucking !== undefined ? Boolean(body.vocalDucking) : undefined,
      vocalDuckDb: body.vocalDuckDb !== undefined ? Number(body.vocalDuckDb) : undefined,
      layeredTransitions:
        body.layeredTransitions !== undefined ? Boolean(body.layeredTransitions) : undefined,
      stemProviderPreference: body.stemProviderPreference,
    });

    res.json({
      success: true,
      guildId,
      settings: updated,
    });
  });

  /**
   * GET /api/stems/tracks/:trackId
   * Returns stem paths, quality score, and vocal features for a track.
   */
  router.get('/tracks/:trackId', async (req: Request, res: Response) => {
    const { trackId } = req.params;
    if (!playbackManager?.stemManager) {
      return res.status(503).json({ error: 'StemManager not available' });
    }

    try {
      const stems = await playbackManager.stemManager.getStems(trackId);
      const vocalFeatures = await playbackManager.stemManager.getVocalFeatures(trackId);

      if (!stems && !vocalFeatures) {
        return res.status(404).json({
          success: false,
          error: `No stems or vocal features found for track ${trackId}`,
        });
      }

      res.json({
        success: true,
        trackId,
        stems,
        vocalFeatures,
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/stems/tracks/:trackId/analyze
   * Enqueues background stem separation and vocal analysis for a track.
   */
  router.post('/tracks/:trackId/analyze', async (req: Request, res: Response) => {
    const { trackId } = req.params;
    const body = req.body || {};

    let filePath = body.filePath;
    let duration = body.duration;
    let title = body.title || 'Track';

    if (!filePath && trackManager) {
      const track = await trackManager.getTrackById(trackId);
      if (track) {
        title = track.title;
        duration = track.duration ?? undefined;
        const source = await trackManager.getPrimarySourceByTrackId(trackId);
        if (source && (source.provider === 'local' || source.sourceType === 'file')) {
          filePath = source.sourceUrl;
        }
      }
    }

    if (!filePath) {
      return res.status(400).json({
        success: false,
        error: 'Cannot determine audio file path for track',
      });
    }

    const workerPool = StemWorkerPool.getInstance(playbackManager?.stemManager);
    const job = workerPool.enqueue(
      { trackId, filePath, duration, title },
      {
        provider: body.provider,
        model: body.model,
        storageMode: body.storageMode || 'persistent',
        force: Boolean(body.force),
      },
      body.priority === 'HIGH' ? 'HIGH' : 'LOW',
    );

    res.status(202).json({
      success: true,
      message: 'Stem separation job enqueued',
      jobId: job.id,
      status: job.status,
      trackId,
    });
  });

  /**
   * GET /api/stems/jobs/:jobId
   * Returns current status of a stem separation job.
   */
  router.get('/jobs/:jobId', (req: Request, res: Response) => {
    const { jobId } = req.params;
    const workerPool = StemWorkerPool.getInstance();
    const job = workerPool.getJob(jobId);

    if (!job) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    res.json({
      success: true,
      job: {
        id: job.id,
        trackId: job.trackId,
        status: job.status,
        provider: job.provider,
        priority: job.priority,
        error: job.error,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        hasResult: Boolean(job.result),
      },
    });
  });

  return router;
}
