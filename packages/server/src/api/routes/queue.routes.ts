import { Router } from 'express';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  resolveMusicStorageDir,
  SUPPORTED_AUDIO_EXTENSIONS,
  type PlaybackManager,
  type AudioSourceManager,
  type TrackManager,
  type QueueTrack,
} from '@gakki/core';
import { enqueueFolder, enqueueMultipleFiles } from '../../audio/batch-loader';
import { resolveAnyAudioInput } from '../../audio/track-resolver';
import { probeAudioMetadata } from '../../audio/ffmpeg';

export function queueRoutes(
  playbackManager?: PlaybackManager,
  audioSourceManager?: AudioSourceManager,
  trackManager?: TrackManager,
): Router {
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
   * Add one or multiple tracks (local file, URL, stream, or Spotify ID) to the queue.
   * Body: { files?: string[], track?: string, addedBy?: string }
   */
  router.post('/:guildId/tracks', async (req, res) => {
    const { guildId } = req.params;
    const { files, track, addedBy } = req.body;

    const inputs: string[] = [];
    if (Array.isArray(files) && files.length > 0) {
      inputs.push(...files);
    } else if (typeof track === 'string' && track.trim()) {
      inputs.push(track.trim());
    }

    if (inputs.length === 0) {
      res.status(400).json({ error: 'Body must include a non-empty "files" array or "track" string.' });
      return;
    }

    if (!playbackManager) {
      res.status(503).json({ error: 'Playback manager not initialized.' });
      return;
    }

    try {
      const addedTracks: QueueTrack[] = [];
      const errors: string[] = [];

      for (const item of inputs) {
        if (!item || typeof item !== 'string' || !item.trim()) continue;
        try {
          const resolved = await resolveAnyAudioInput(item, audioSourceManager, trackManager);
          const added = playbackManager.queueManager.addTrack(guildId, {
            name: resolved.name,
            path: resolved.path,
            duration: resolved.duration,
            artist: resolved.artist,
            album: resolved.album,
            thumbnailUrl: resolved.thumbnailUrl,
            sourceProvider: resolved.sourceProvider,
            sourceUrl: resolved.sourceUrl,
            addedBy: addedBy || 'Web/API',
          });
          addedTracks.push(added);
        } catch (itemErr: any) {
          errors.push(itemErr.message);
        }
      }

      if (addedTracks.length === 0 && errors.length > 0) {
        res.status(400).json({ error: errors[0], allErrors: errors });
        return;
      }

      // Auto-start playback if player is currently IDLE and nothing is playing
      const currentTrack = playbackManager.getCurrentTrack(guildId);
      const isIdle = !currentTrack && playbackManager.getPlaybackStatus(guildId) === 'IDLE';
      if (isIdle) {
        playbackManager.advanceQueue(guildId).catch(() => {});
      }

      res.status(201).json({
        guildId,
        addedCount: addedTracks.length,
        tracks: addedTracks.map((t) => ({ id: t.id, name: t.name, duration: t.duration })),
        queueLength: playbackManager.queueManager.getQueueLength(guildId),
        errors: errors.length > 0 ? errors : undefined,
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to enqueue tracks' });
    }
  });

  /**
   * POST /api/queue/:guildId/upload
   * Stream and upload a local audio file directly from the client and add to queue.
   */
  router.post('/:guildId/upload', async (req, res) => {
    const { guildId } = req.params;
    if (!playbackManager) {
      res.status(503).json({ error: 'Playback manager not initialized.' });
      return;
    }

    const rawFilename =
      (req.query.filename as string) ||
      (req.headers['x-filename'] as string) ||
      'uploaded_track.mp3';

    const safeBaseName = path.basename(rawFilename).replace(/[^a-zA-Z0-9._-]/g, '_');
    const ext = path.extname(safeBaseName).toLowerCase();

    if (!SUPPORTED_AUDIO_EXTENSIONS.includes(ext)) {
      res.status(400).json({
        error: `Unsupported audio format "${ext}". Supported: ${SUPPORTED_AUDIO_EXTENSIONS.join(', ')}`,
      });
      return;
    }

    const musicDir = resolveMusicStorageDir();
    if (!fs.existsSync(musicDir)) {
      fs.mkdirSync(musicDir, { recursive: true });
    }

    const targetPath = path.join(musicDir, safeBaseName);
    const writeStream = fs.createWriteStream(targetPath);

    req.pipe(writeStream);

    writeStream.on('error', (err) => {
      res.status(500).json({ error: `File upload failed: ${err.message}` });
    });

    writeStream.on('finish', async () => {
      try {
        let duration: number | undefined;
        let title = path.basename(safeBaseName, ext);
        let artist: string | undefined;

        try {
          const probed = await probeAudioMetadata(targetPath);
          duration = probed.duration ?? undefined;
          if (probed.title) title = probed.title;
          if (probed.artist) artist = probed.artist;
        } catch {
          // ignore probe error
        }

        const added = playbackManager.queueManager.addTrack(guildId, {
          name: title,
          path: safeBaseName,
          duration,
          artist,
          sourceProvider: 'upload',
          addedBy: 'Web Upload',
        });

        // Auto-advance if idle
        const currentTrack = playbackManager.getCurrentTrack(guildId);
        const isIdle = !currentTrack && playbackManager.getPlaybackStatus(guildId) === 'IDLE';
        if (isIdle) {
          playbackManager.advanceQueue(guildId).catch(() => {});
        }

        res.status(201).json({
          success: true,
          guildId,
          track: { id: added.id, name: added.name, duration: added.duration },
          queueLength: playbackManager.queueManager.getQueueLength(guildId),
        });
      } catch (err: any) {
        res.status(500).json({ error: `Failed to process uploaded track: ${err.message}` });
      }
    });
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
