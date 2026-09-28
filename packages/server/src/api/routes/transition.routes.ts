import { Router, Request, Response } from 'express';
import type { PlaybackManager, TrackTransitionFeatures } from '@gakki/core';
import { getFFmpegCapabilities } from '../../audio/ffmpeg-capabilities';
import { createLogger } from '@gakki/core';

const logger = createLogger('transition-routes');

export function transitionRoutes(playbackManager?: PlaybackManager): Router {
  const router = Router();

  /**
   * GET /api/guilds/:guildId/transition
   * Returns current transition configuration, FFmpeg capabilities, and any prepared transition.
   */
  router.get('/:guildId/transition', (req: Request, res: Response) => {
    const { guildId } = req.params;
    if (!playbackManager) {
      return res.status(503).json({ error: 'PlaybackManager not available' });
    }

    const settings = playbackManager.getTransitionSettings(guildId);
    const capabilities = getFFmpegCapabilities();
    const prepared = playbackManager.getPreparedTransition(guildId);

    res.json({
      success: true,
      guildId,
      settings,
      capabilities: capabilities
        ? {
            acrossfade: capabilities.acrossfade,
            rubberband: capabilities.rubberband,
            loudnorm: capabilities.loudnorm,
            atempo: capabilities.atempo,
          }
        : null,
      prepared: prepared
        ? {
            planId: prepared.plan.id,
            durationSeconds: prepared.plan.durationSeconds,
            profile: prepared.plan.profile,
            score: prepared.plan.score,
            fallbackLevel: prepared.plan.fallbackLevel,
            outgoingCueSeconds: prepared.plan.outgoingCueSeconds,
            incomingCueSeconds: prepared.plan.incomingCueSeconds,
            tempoAdjustmentPercent: prepared.plan.tempoAdjustmentPercent,
            pitchShiftSemitones: prepared.plan.pitchShiftSemitones,
            nextTrack: {
              id: prepared.nextTrack.id,
              name: prepared.nextTrack.name,
              artist: prepared.nextTrack.artist,
            },
          }
        : null,
    });
  });

  /**
   * POST /api/guilds/:guildId/transition
   * Update guild transition configuration.
   */
  router.post('/:guildId/transition', (req: Request, res: Response) => {
    const { guildId } = req.params;
    if (!playbackManager) {
      return res.status(503).json({ error: 'PlaybackManager not available' });
    }

    const body = req.body || {};
    const updated = playbackManager.setTransitionSettings(guildId, {
      transitionEnabled: body.transitionEnabled !== undefined ? Boolean(body.transitionEnabled) : undefined,
      transitionDuration: body.transitionDuration !== undefined ? Number(body.transitionDuration) : undefined,
      transitionProfile: body.transitionProfile,
      harmonicMixing: body.harmonicMixing !== undefined ? Boolean(body.harmonicMixing) : undefined,
      autoTempo: body.autoTempo !== undefined ? Boolean(body.autoTempo) : undefined,
      loudnessNormalize: body.loudnessNormalize !== undefined ? Boolean(body.loudnessNormalize) : undefined,
    });

    res.json({
      success: true,
      guildId,
      settings: updated,
    });
  });

  /**
   * GET /api/guilds/:guildId/transition/preview
   * Get dynamic preview information of current -> next track transition.
   */
  router.get('/:guildId/transition/preview', async (req: Request, res: Response) => {
    const { guildId } = req.params;
    if (!playbackManager) {
      return res.status(503).json({ error: 'PlaybackManager not available' });
    }

    const currentTrack = (playbackManager as any).currentTracks?.get(guildId);
    const queue = playbackManager.queueManager.getOrCreateQueue(guildId).tracks;
    const nextTrack = queue[0];

    if (!currentTrack || !nextTrack) {
      return res.json({
        available: false,
        message: !currentTrack ? 'No track is currently playing' : 'Queue is empty (no next track)',
      });
    }

    let fromFeatures: TrackTransitionFeatures | null = null;
    let toFeatures: TrackTransitionFeatures | null = null;

    if (playbackManager.transitionFeatureManager) {
      if (currentTrack.trackId) {
        fromFeatures = await playbackManager.transitionFeatureManager.getFeatures(currentTrack.trackId);
      }
      if (nextTrack.trackId) {
        toFeatures = await playbackManager.transitionFeatureManager.getFeatures(nextTrack.trackId);
      }
    }

    const settings = playbackManager.getTransitionSettings(guildId);
    const plan = playbackManager.transitionEngine.planTransition({
      guildId,
      fromTrackId: currentTrack.trackId || currentTrack.id,
      toTrackId: nextTrack.trackId || nextTrack.id,
      fromTrackDuration: currentTrack.duration || 180,
      toTrackDuration: nextTrack.duration || 180,
      fromFeatures,
      toFeatures,
      settings,
      rubberBandAvailable: getFFmpegCapabilities()?.rubberband ?? true,
    });

    res.json({
      available: true,
      currentTrack: {
        id: currentTrack.id,
        name: currentTrack.name,
        artist: currentTrack.artist,
        duration: currentTrack.duration,
        key: fromFeatures?.key || null,
        camelot: fromFeatures?.camelotCode || null,
        lufs: fromFeatures?.integratedLoudnessLufs || null,
      },
      nextTrack: {
        id: nextTrack.id,
        name: nextTrack.name,
        artist: nextTrack.artist,
        duration: nextTrack.duration,
        key: toFeatures?.key || null,
        camelot: toFeatures?.camelotCode || null,
        lufs: toFeatures?.integratedLoudnessLufs || null,
      },
      plan: {
        durationSeconds: plan.durationSeconds,
        profile: plan.profile,
        curve: plan.curve,
        fallbackLevel: plan.fallbackLevel,
        score: plan.score,
        outgoingCueSeconds: plan.outgoingCueSeconds,
        incomingCueSeconds: plan.incomingCueSeconds,
        tempoAdjustmentPercent: plan.tempoAdjustmentPercent,
        pitchShiftSemitones: plan.pitchShiftSemitones,
        explanation: plan.explanation,
      },
    });
  });

  return router;
}
