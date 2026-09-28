import { Router, type Request, type Response } from 'express';
import type {
  AiRecommendationManager,
  AudioFeatureManager,
  PlaybackManager,
  DJProfile,
} from '@gakki/core';
import { createLogger } from '@gakki/core';
import { broadcastEvent } from '../../websocket';

const logger = createLogger('recommendation-routes');

export function recommendationRoutes(
  recManager?: AiRecommendationManager,
  playbackManager?: PlaybackManager,
): Router {
  const router = Router();

  /**
   * GET /api/recommendations/similar/:trackId
   * Return tracks acoustically similar to the specified track.
   */
  router.get('/similar/:trackId', async (req: Request, res: Response) => {
    if (!recManager) {
      return res.status(503).json({ error: 'Recommendation service not available' });
    }

    try {
      const { trackId } = req.params;
      const limit = Math.min(25, Math.max(1, parseInt(req.query.limit as string) || 10));
      const profile = (req.query.profile as DJProfile) || 'BALANCED';

      const similar = await recManager.getSimilarTracks(trackId, limit, profile);
      return res.json({
        seedTrackId: trackId,
        profile,
        count: similar.length,
        tracks: similar,
      });
    } catch (err: any) {
      logger.error({ err, trackId: req.params.trackId }, 'Failed to fetch similar tracks');
      return res.status(500).json({ error: 'Failed to fetch similar tracks' });
    }
  });

  /**
   * GET /api/recommendations/features/:trackId
   * Retrieve extracted acoustic features for a track.
   */
  router.get('/features/:trackId', async (req: Request, res: Response) => {
    if (!recManager) {
      return res.status(503).json({ error: 'Recommendation service not available' });
    }

    try {
      const { trackId } = req.params;
      const features = await recManager.featureManager.getFeatures(trackId);
      if (!features) {
        return res.status(404).json({ error: 'Acoustic features not found for track' });
      }

      return res.json(features);
    } catch (err: any) {
      logger.error({ err, trackId: req.params.trackId }, 'Failed to fetch track features');
      return res.status(500).json({ error: 'Failed to fetch track features' });
    }
  });

  /**
   * GET /api/recommendations/next/:guildId
   * Get the next recommended track for a guild according to Dynamic DJ context.
   */
  router.get('/next/:guildId', async (req: Request, res: Response) => {
    if (!recManager) {
      return res.status(503).json({ error: 'Recommendation service not available' });
    }

    try {
      const { guildId } = req.params;
      const currentTrack = playbackManager?.getCurrentTrack(guildId);
      const queue = playbackManager ? playbackManager.queueManager.inspectQueue(guildId) : [];

      const candidate = await recManager.selectNextTrack({
        guildId,
        seedTrackId: (currentTrack as any)?.trackId,
        queueTrackIds: queue.map((t: any) => t.trackId).filter(Boolean) as string[],
      });

      if (!candidate) {
        return res.status(404).json({ error: 'No recommendation candidates available' });
      }

      return res.json({
        guildId,
        candidate,
      });
    } catch (err: any) {
      logger.error({ err, guildId: req.params.guildId }, 'Failed to get next recommendation');
      return res.status(500).json({ error: 'Failed to get next recommendation' });
    }
  });

  /**
   * POST /api/recommendations/vibe
   * Generate a "Same Vibe" playlist starting from a seed track.
   */
  router.post('/vibe', async (req: Request, res: Response) => {
    if (!recManager) {
      return res.status(503).json({ error: 'Recommendation service not available' });
    }

    try {
      const { seedTrackId, guildId, limit, profile } = req.body;
      if (!seedTrackId || !guildId) {
        return res.status(400).json({ error: 'Missing required parameters: seedTrackId and guildId' });
      }

      const recResult = await recManager.generateVibePlaylist(
        seedTrackId,
        guildId,
        Math.min(25, Math.max(1, limit || 10)),
        profile || 'BALANCED',
      );

      broadcastEvent({
        type: 'recommendation.generated',
        guildId,
        mode: 'vibe',
        trackId: seedTrackId,
        count: recResult.tracks.length,
      });

      return res.json(recResult);
    } catch (err: any) {
      logger.error({ err }, 'Failed to generate vibe playlist');
      return res.status(500).json({ error: 'Failed to generate vibe playlist' });
    }
  });

  /**
   * GET /api/recommendations/dj/:guildId
   * Get dynamic DJ state and lookahead queue for a guild.
   */
  router.get('/dj/:guildId', (req: Request, res: Response) => {
    if (!recManager) {
      return res.status(503).json({ error: 'Recommendation service not available' });
    }

    const { guildId } = req.params;
    const djState = recManager.getDJState(guildId);
    return res.json(djState);
  });

  /**
   * POST /api/recommendations/dj/toggle
   * Toggle or configure Dynamic DJ mode.
   */
  router.post('/dj/toggle', (req: Request, res: Response) => {
    if (!recManager) {
      return res.status(503).json({ error: 'Recommendation service not available' });
    }

    const { guildId, enabled, profile } = req.body;
    if (!guildId) {
      return res.status(400).json({ error: 'Missing required parameter: guildId' });
    }

    const updatedState = recManager.configureDJ(guildId, { enabled, profile });

    broadcastEvent({
      type: updatedState.enabled ? 'dj.enabled' : 'dj.disabled',
      guildId,
      profile: updatedState.profile,
    });

    return res.json(updatedState);
  });

  /**
   * POST /api/recommendations/smart-shuffle/:guildId
   * Reorder guild queue using Smart Shuffle.
   */
  router.post('/smart-shuffle/:guildId', async (req: Request, res: Response) => {
    if (!recManager || !playbackManager) {
      return res.status(503).json({ error: 'Recommendation or playback manager not available' });
    }

    try {
      const { guildId } = req.params;
      const { profile } = req.body;
      const queue = playbackManager.queueManager.inspectQueue(guildId);
      const current = playbackManager.getCurrentTrack(guildId);

      if (queue.length <= 1) {
        return res.json({ guildId, queue, message: 'Queue too small to smart-shuffle' });
      }

      const shuffled = await recManager.smartShuffle(guildId, queue, current, profile);
      // Replace queue in PlaybackManager
      (playbackManager as any).queueManager?.setQueue(guildId, shuffled);

      broadcastEvent({
        type: 'recommendation.generated',
        guildId,
        mode: 'smart-shuffle',
        count: shuffled.length,
      });

      return res.json({
        guildId,
        count: shuffled.length,
        queue: shuffled,
      });
    } catch (err: any) {
      logger.error({ err, guildId: req.params.guildId }, 'Failed to execute smart shuffle');
      return res.status(500).json({ error: 'Failed to execute smart shuffle' });
    }
  });

  return router;
}
