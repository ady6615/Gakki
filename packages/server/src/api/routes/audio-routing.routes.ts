import { Router } from 'express';
import type { PlaybackManager, PlaybackTarget } from '@gakki/core';
import { createLogger } from '@gakki/core';

const logger = createLogger('audio-routing-routes');

export function audioRoutingRoutes(playbackManager?: PlaybackManager): Router {
  const router = Router();

  /**
   * GET /api/audio/devices
   * List all audio output and input devices, plus current routing state.
   */
  router.get('/devices', async (_req, res) => {
    if (!playbackManager) {
      res.status(503).json({ success: false, error: 'Playback manager not available' });
      return;
    }

    try {
      const allDevices = await playbackManager.audioRoutingManager.getAllDevices();
      const state = await playbackManager.getAudioRoutingState();
      res.json({
        success: true,
        state,
        ...allDevices,
      });
    } catch (err: any) {
      logger.error({ err }, 'Error retrieving audio devices');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /api/audio/state
   * Retrieve active audio routing state snapshot.
   */
  router.get('/state', async (_req, res) => {
    if (!playbackManager) {
      res.status(503).json({ success: false, error: 'Playback manager not available' });
      return;
    }

    try {
      const state = await playbackManager.getAudioRoutingState();
      res.json({ success: true, state });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/audio/target
   * Switch the active playback target (discord | desktop | virtual).
   * Seamless transition preserving track, queue, volume, filters, and DJ state.
   */
  router.post('/target', async (req, res) => {
    if (!playbackManager) {
      res.status(503).json({ success: false, error: 'Playback manager not available' });
      return;
    }

    const { target } = req.body;
    if (!target || !['discord', 'desktop', 'virtual'].includes(target)) {
      res.status(400).json({
        success: false,
        error: "Target must be 'discord', 'desktop', or 'virtual'",
      });
      return;
    }

    try {
      await playbackManager.switchPlaybackTarget(target as PlaybackTarget);
      const state = await playbackManager.getAudioRoutingState();
      res.json({ success: true, target, state });
    } catch (err: any) {
      logger.error({ err, target }, 'Error switching playback target');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/audio/device
   * Switch the active audio output or input device.
   */
  router.post('/device', async (req, res) => {
    if (!playbackManager) {
      res.status(503).json({ success: false, error: 'Playback manager not available' });
      return;
    }

    const { deviceId, type } = req.body;
    if (!deviceId) {
      res.status(400).json({ success: false, error: 'deviceId is required' });
      return;
    }

    try {
      if (type === 'input') {
        await playbackManager.setInputDevice(deviceId);
      } else {
        await playbackManager.setOutputDevice(deviceId);
      }
      const state = await playbackManager.getAudioRoutingState();
      res.json({ success: true, state });
    } catch (err: any) {
      logger.error({ err, deviceId }, 'Error selecting audio device');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/audio/monitor
   * Configure loopback / audio monitoring with anti-feedback loop protection (Requirement 12).
   */
  router.post('/monitor', async (req, res) => {
    if (!playbackManager) {
      res.status(503).json({ success: false, error: 'Playback manager not available' });
      return;
    }

    const { enabled, monitorDeviceId } = req.body;
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ success: false, error: 'enabled boolean flag is required' });
      return;
    }

    const result = playbackManager.setMonitoring(enabled, monitorDeviceId);
    if (!result.success) {
      res.status(400).json({ success: false, error: result.error });
      return;
    }

    const state = await playbackManager.getAudioRoutingState();
    res.json({ success: true, state });
  });

  /**
   * GET /api/audio/stream
   * Stream live audio to desktop client or web player (Requirement 6 & 13).
   * Exposes authoritative 48kHz stereo stream.
   */
  router.get('/stream', async (req, res) => {
    if (!playbackManager) {
      res.status(503).json({ success: false, error: 'Playback manager not available' });
      return;
    }

    const desktopAdapter = playbackManager.getAdapterByPlatform('desktop');
    const currentTrack = desktopAdapter ? desktopAdapter.getCurrentTrack('') : null;

    if (!currentTrack || !currentTrack.filePath) {
      res.status(404).json({ success: false, error: 'No active audio track playing' });
      return;
    }

    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');

    try {
      const source = playbackManager.createAudioSource({
        name: currentTrack.name,
        path: currentTrack.filePath,
      } as any);
      await source.validate();
      const rawStream = await source.getStream();
      rawStream.pipe(res);

      req.on('close', () => {
        if ('destroy' in rawStream) {
          rawStream.destroy();
        }
      });
    } catch (err: any) {
      logger.error({ err }, 'Error piping audio stream');
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: err.message });
      }
    }
  });

  return router;
}
