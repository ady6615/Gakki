import { Router } from 'express';
import type { PlaybackManager, AudioPlayerManager, LoopMode } from '@gakki/core';
import { listLocalAudioFiles } from '../../audio/local-files';

export function playbackRoutes(manager?: PlaybackManager | AudioPlayerManager): Router {
  const router = Router();

  const activePlaybackManager: PlaybackManager | undefined =
    manager && 'playbackManager' in manager
      ? (manager as AudioPlayerManager).playbackManager
      : (manager as PlaybackManager | undefined);

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
    if (!activePlaybackManager) {
      res.json({
        primary: {
          guildId: null,
          voiceState: 'DISCONNECTED',
          playerState: 'IDLE',
          track: null,
        },
        all: [],
      });
      return;
    }

    const state = activePlaybackManager.getState('');
    res.json({
      primary: state,
      all: [state],
    });
  });

  /**
   * GET /api/playback/:guildId/state
   * Retrieve authoritative guild playback state including volume, filters, loop mode, stayInChannel.
   */
  router.get('/:guildId/state', (req, res) => {
    const { guildId } = req.params;
    if (!activePlaybackManager) {
      res.status(503).json({ success: false, error: 'Playback manager not initialized' });
      return;
    }
    const state = activePlaybackManager.getGuildState(guildId);
    res.json({ success: true, state });
  });

  /**
   * POST /api/playback/:guildId/volume
   * Set volume for a guild (0 to 200).
   */
  router.post('/:guildId/volume', (req, res) => {
    const { guildId } = req.params;
    const { volume } = req.body;

    if (!activePlaybackManager) {
      res.status(503).json({ success: false, error: 'Playback manager not initialized' });
      return;
    }

    if (volume === undefined || typeof volume !== 'number' || isNaN(volume)) {
      res.status(400).json({ success: false, error: 'Volume must be a valid number between 0 and 200' });
      return;
    }

    const updated = activePlaybackManager.setVolume(guildId, volume);
    res.json({ success: true, volume: updated });
  });

  /**
   * POST /api/playback/:guildId/filters
   * Update audio filters (bassboost, speed, nightcore).
   */
  router.post('/:guildId/filters', async (req, res) => {
    const { guildId } = req.params;
    const { bassboost, speed, nightcore } = req.body;

    if (!activePlaybackManager) {
      res.status(503).json({ success: false, error: 'Playback manager not initialized' });
      return;
    }

    try {
      if (bassboost !== undefined) {
        await activePlaybackManager.setBassboost(guildId, Boolean(bassboost));
      }
      if (speed !== undefined) {
        await activePlaybackManager.setSpeed(guildId, Number(speed));
      }
      if (nightcore !== undefined) {
        await activePlaybackManager.setNightcore(guildId, Boolean(nightcore));
      }

      const filters = activePlaybackManager.getFilters(guildId);
      res.json({ success: true, filters });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/playback/:guildId/loop
   * Set loop mode ('off' | 'track' | 'queue').
   */
  router.post('/:guildId/loop', (req, res) => {
    const { guildId } = req.params;
    const { mode } = req.body;

    if (!activePlaybackManager) {
      res.status(503).json({ success: false, error: 'Playback manager not initialized' });
      return;
    }

    if (!['off', 'track', 'queue'].includes(mode)) {
      res.status(400).json({ success: false, error: "Mode must be 'off', 'track', or 'queue'" });
      return;
    }

    const setMode = activePlaybackManager.setLoopMode(guildId, mode as LoopMode);
    res.json({ success: true, loopMode: setMode });
  });

  /**
   * POST /api/playback/:guildId/stay
   * Set stay-in-channel mode.
   */
  router.post('/:guildId/stay', (req, res) => {
    const { guildId } = req.params;
    const { stay } = req.body;

    if (!activePlaybackManager) {
      res.status(503).json({ success: false, error: 'Playback manager not initialized' });
      return;
    }

    const updated = activePlaybackManager.setStayInChannel(guildId, Boolean(stay));
    res.json({ success: true, stayInChannel: updated });
  });

  /**
   * POST /api/playback/:guildId/shuffle
   * Shuffle queued tracks for a guild.
   */
  router.post('/:guildId/shuffle', (req, res) => {
    const { guildId } = req.params;
    if (!activePlaybackManager) {
      res.status(503).json({ success: false, error: 'Playback manager not initialized' });
      return;
    }

    const shuffled = activePlaybackManager.shuffleQueue(guildId);
    res.json({
      success: true,
      shuffled,
      queueLength: activePlaybackManager.queueManager.getQueueLength(guildId),
    });
  });

  /**
   * POST /api/playback/:guildId/move
   * Move track from one 1-based index to another.
   */
  router.post('/:guildId/move', (req, res) => {
    const { guildId } = req.params;
    const { from, to } = req.body;

    if (!activePlaybackManager) {
      res.status(503).json({ success: false, error: 'Playback manager not initialized' });
      return;
    }

    if (typeof from !== 'number' || typeof to !== 'number') {
      res.status(400).json({ success: false, error: 'from and to positions must be numbers' });
      return;
    }

    const moved = activePlaybackManager.moveQueueTrack(guildId, from, to);
    if (!moved) {
      res.status(400).json({ success: false, error: 'Invalid from or to position' });
      return;
    }

    res.json({ success: true, track: moved });
  });

  return router;
}

export const createPlaybackRouter = playbackRoutes;
