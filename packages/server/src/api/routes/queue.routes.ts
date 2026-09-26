import { Router } from 'express';
import type { PlaybackManager } from '@gakki/core';
import { enqueueFolder, enqueueMultipleFiles } from '../../audio/batch-loader';

export function queueRoutes(playbackManager?: PlaybackManager): Router {
  const router = Router();

  /**
   * GET /api/queue/:guildId
   * Inspect current queue and currently playing track for a guild.
   */
  router.get('/:guildId', (req, res) => {
    const { guildId } = req.params;
    if (!playbackManager) {
      res.json({
        guildId,
        currentTrack: null,
        queue: [],
        length: 0,
      });
      return;
    }

    const event = playbackManager.getQueueEvent(guildId);
    res.json(event);
  });

  /**
   * POST /api/queue/:guildId/tracks
   * Add multiple local files in one operation.
   * Body: { files: string[] }
   */
  router.post('/:guildId/tracks', async (req, res, next) => {
    const { guildId } = req.params;
    const { files, addedBy } = req.body;

    if (!Array.isArray(files) || files.length === 0) {
      res.status(400).json({ error: 'Body must include a non-empty "files" array.' });
      return;
    }

    if (!playbackManager) {
      res.status(503).json({ error: 'Playback manager not initialized.' });
      return;
    }

    try {
      const added = await enqueueMultipleFiles(
        guildId,
        files,
        playbackManager.queueManager,
        addedBy,
      );
      res.status(201).json({
        guildId,
        addedCount: added.length,
        tracks: added.map((t) => ({ id: t.id, name: t.name })),
        queueLength: playbackManager.queueManager.getQueueLength(guildId),
      });
    } catch (err: any) {
      next(err);
    }
  });

  /**
   * POST /api/queue/:guildId/folder
   * Add all audio files from a local folder in deterministic filename order.
   * Body: { folder: string }
   */
  router.post('/:guildId/folder', async (req, res, next) => {
    const { guildId } = req.params;
    const { folder, addedBy } = req.body;

    if (!folder || typeof folder !== 'string') {
      res.status(400).json({ error: 'Body must include a "folder" string.' });
      return;
    }

    if (!playbackManager) {
      res.status(503).json({ error: 'Playback manager not initialized.' });
      return;
    }

    try {
      const added = await enqueueFolder(
        guildId,
        folder,
        playbackManager.queueManager,
        addedBy,
      );
      res.status(201).json({
        guildId,
        folder,
        addedCount: added.length,
        tracks: added.map((t) => ({ id: t.id, name: t.name })),
        queueLength: playbackManager.queueManager.getQueueLength(guildId),
      });
    } catch (err: any) {
      next(err);
    }
  });

  /**
   * DELETE /api/queue/:guildId
   * Clear the guild queue.
   */
  router.delete('/:guildId', (req, res) => {
    const { guildId } = req.params;
    if (!playbackManager) {
      res.status(503).json({ error: 'Playback manager not initialized.' });
      return;
    }

    playbackManager.queueManager.clearQueue(guildId);
    res.json({ guildId, message: 'Queue cleared' });
  });

  /**
   * DELETE /api/queue/:guildId/tracks/:index
   * Remove a track at a specific position (1-based index).
   */
  router.delete('/:guildId/tracks/:index', (req, res) => {
    const { guildId, index } = req.params;
    const numericIndex = parseInt(index, 10);

    if (isNaN(numericIndex) || numericIndex < 1) {
      res.status(400).json({ error: 'Index must be a positive 1-based number.' });
      return;
    }

    if (!playbackManager) {
      res.status(503).json({ error: 'Playback manager not initialized.' });
      return;
    }

    const removed = playbackManager.queueManager.removeByIndex(guildId, numericIndex, true);
    if (!removed) {
      res.status(404).json({ error: `No track found at position ${numericIndex}.` });
      return;
    }

    res.json({
      guildId,
      removed: { id: removed.id, name: removed.name },
      queueLength: playbackManager.queueManager.getQueueLength(guildId),
    });
  });

  return router;
}
