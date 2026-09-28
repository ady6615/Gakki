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

  /**
   * POST /api/queue/:guildId/reorder
   * Reorder queued items from web drag-and-drop (Requirement 9 & 10).
   * Body: { orderedTrackIds: string[] }
   */
  router.post('/:guildId/reorder', (req, res) => {
    const { guildId } = req.params;
    const { orderedTrackIds } = req.body;

    if (!Array.isArray(orderedTrackIds)) {
      res.status(400).json({ error: 'Body must include "orderedTrackIds" array.' });
      return;
    }

    if (!playbackManager) {
      res.status(503).json({ error: 'Playback manager not initialized.' });
      return;
    }

    playbackManager.queueManager.reorderQueue(guildId, orderedTrackIds);
    const authoritativeEvent = playbackManager.getQueueEvent(guildId);
    res.json(authoritativeEvent);
  });

  /**
   * POST /api/queue/:guildId/move
   * Targeted queue actions: move to top, bottom, play next, up, down (Requirement 9 & 24).
   * Body: { trackId: string, action: 'top' | 'bottom' | 'next' | 'up' | 'down' }
   */
  router.post('/:guildId/move', (req, res) => {
    const { guildId } = req.params;
    const { trackId, action } = req.body;

    if (!trackId || !action) {
      res.status(400).json({ error: 'trackId and action are required.' });
      return;
    }

    if (!playbackManager) {
      res.status(503).json({ error: 'Playback manager not initialized.' });
      return;
    }

    const currentTracks = playbackManager.queueManager.inspectQueue(guildId);
    const currentIndex = currentTracks.findIndex((t) => t.id === trackId);

    if (currentIndex === -1) {
      res.status(404).json({ error: 'Track not found in queue.' });
      return;
    }

    if (action === 'top' || action === 'next') {
      playbackManager.queueManager.moveToTop(guildId, trackId);
    } else if (action === 'bottom') {
      playbackManager.queueManager.moveToBottom(guildId, trackId);
    } else if (action === 'up' && currentIndex > 0) {
      playbackManager.queueManager.moveTrack(guildId, currentIndex + 1, currentIndex, true);
    } else if (action === 'down' && currentIndex < currentTracks.length - 1) {
      playbackManager.queueManager.moveTrack(guildId, currentIndex + 1, currentIndex + 2, true);
    }

    const authoritativeEvent = playbackManager.getQueueEvent(guildId);
    res.json(authoritativeEvent);
  });

  return router;
}
