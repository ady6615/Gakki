import { Router } from 'express';
import type { AudioPlayerManager } from '@gakki/core';
import { listLocalAudioFiles } from '../../audio/local-files';

export function playbackRoutes(playerManager?: AudioPlayerManager): Router {
  const router = Router();

  /**
   * GET /api/playback/files
   * List available audio files in the server-side local storage directory.
   */
  router.get('/files', async (_req, res, next) => {
    try {
      const files = await listLocalAudioFiles();
      res.json({ files });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/playback
   * Get all active guild playback states, or default state if none active.
   */
  router.get('/', (_req, res) => {
    if (!playerManager) {
      res.json({
        guildId: null,
        voiceState: 'DISCONNECTED',
        playerState: 'IDLE',
        track: null,
      });
      return;
    }

    const allStates = playerManager.getAllStates();
    if (allStates.length > 0) {
      res.json({
        primary: allStates[0],
        all: allStates,
      });
    } else {
      res.json({
        primary: {
          guildId: null,
          voiceState: 'DISCONNECTED',
          playerState: 'IDLE',
          track: null,
        },
        all: [],
      });
    }
  });

  /**
   * GET /api/playback/:guildId
   * Get playback state for a specific Discord guild.
   */
  router.get('/:guildId', (req, res) => {
    const { guildId } = req.params;
    if (!playerManager) {
      res.json({
        guildId,
        voiceState: 'DISCONNECTED',
        playerState: 'IDLE',
        track: null,
      });
      return;
    }

    const state = playerManager.getState(guildId);
    res.json(state);
  });

  return router;
}
