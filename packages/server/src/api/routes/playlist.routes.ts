import { Router, type Request, type Response } from 'express';
import type {
  PlaylistManager,
  PlaybackManager,
  AudioSourceManager,
  TrackManager,
  QueueTrack,
} from '@gakki/core';
import { LocalAudioSource, HttpAudioSource } from '@gakki/core';
import { broadcastPlaylistEvent } from '../../websocket';

export function playlistRoutes(
  playlistManager?: PlaylistManager,
  playbackManager?: PlaybackManager,
  audioSourceManager?: AudioSourceManager,
  trackManager?: TrackManager,
): Router {
  const router = Router();

  /**
   * GET /api/playlists
   * List user playlists and guild playlists.
   */
  router.get('/', async (req: Request, res: Response) => {
    if (!playlistManager) {
      res.json({ userPlaylists: [], guildPlaylists: [] });
      return;
    }

    try {
      const guildId = req.query.guildId as string | undefined;
      const userId = req.query.userId as string | undefined;

      const playlists = await playlistManager.listPlaylists({ guildId, userId });
      res.json(playlists);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to list playlists' });
    }
  });

  /**
   * POST /api/playlists
   * Create a new playlist.
   */
  router.post('/', async (req: Request, res: Response) => {
    if (!playlistManager) {
      res.status(503).json({ error: 'Playlist service unavailable' });
      return;
    }

    try {
      const { name, description, ownerUserId, guildId, visibility } = req.body;
      if (!name || typeof name !== 'string' || !name.trim()) {
        res.status(400).json({ error: 'Playlist name is required' });
        return;
      }

      const playlist = await playlistManager.createPlaylist({
        name,
        description,
        ownerUserId,
        guildId,
        visibility,
      });

      broadcastPlaylistEvent({
        type: 'playlist.created',
        playlist,
      });

      res.status(201).json(playlist);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to create playlist' });
    }
  });

  /**
   * GET /api/playlists/:id
   * Get playlist details and its ordered tracks.
   */
  router.get('/:id', async (req: Request, res: Response) => {
    if (!playlistManager) {
      res.status(404).json({ error: 'Playlist service unavailable' });
      return;
    }

    try {
      const { id } = req.params;
      const result = await playlistManager.getPlaylist(id);
      if (!result) {
        res.status(404).json({ error: 'Playlist not found' });
        return;
      }

      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to get playlist' });
    }
  });

  /**
   * PATCH /api/playlists/:id
   * Rename a playlist.
   */
  router.patch('/:id', async (req: Request, res: Response) => {
    if (!playlistManager) {
      res.status(503).json({ error: 'Playlist service unavailable' });
      return;
    }

    try {
      const { id } = req.params;
      const { name, userId } = req.body;

      if (!name || typeof name !== 'string' || !name.trim()) {
        res.status(400).json({ error: 'New playlist name is required' });
        return;
      }

      const updated = await playlistManager.renamePlaylist(id, name, userId);

      broadcastPlaylistEvent({
        type: 'playlist.updated',
        playlist: updated,
      });

      res.json(updated);
    } catch (err: any) {
      res.status(err.name === 'PlaylistPermissionError' ? 403 : 500).json({
        error: err.message || 'Failed to update playlist',
      });
    }
  });

  /**
   * DELETE /api/playlists/:id
   * Delete a playlist.
   */
  router.delete('/:id', async (req: Request, res: Response) => {
    if (!playlistManager) {
      res.status(503).json({ error: 'Playlist service unavailable' });
      return;
    }

    try {
      const { id } = req.params;
      const userId = (req.query.userId || req.body?.userId) as string | undefined;

      const deleted = await playlistManager.deletePlaylist(id, userId);
      if (!deleted) {
        res.status(404).json({ error: 'Playlist not found or could not be deleted' });
        return;
      }

      broadcastPlaylistEvent({
        type: 'playlist.deleted',
        playlistId: id,
      });

      res.json({ success: true, playlistId: id });
    } catch (err: any) {
      res.status(err.name === 'PlaylistPermissionError' ? 403 : 500).json({
        error: err.message || 'Failed to delete playlist',
      });
    }
  });

  /**
   * POST /api/playlists/:id/tracks
   * Add a track to a playlist (resolving input if needed).
   */
  router.post('/:id/tracks', async (req: Request, res: Response) => {
    if (!playlistManager) {
      res.status(503).json({ error: 'Playlist service unavailable' });
      return;
    }

    try {
      const { id } = req.params;
      let { trackId, input, addedBy } = req.body;

      if (!trackId && input && audioSourceManager) {
        // Resolve input via audio source manager and persist track
        const resolved = await audioSourceManager.resolve(input);
        if (trackManager) {
          const saved = await trackManager.saveTrackWithSource(
            resolved.metadata,
            resolved.source,
          );
          trackId = saved.track.id;
        }
      }

      if (!trackId) {
        res.status(400).json({ error: 'trackId or valid track input is required' });
        return;
      }

      const playlistTrack = await playlistManager.addTrackToPlaylist(id, trackId, addedBy);

      broadcastPlaylistEvent({
        type: 'playlist.track.added',
        playlistId: id,
        track: playlistTrack,
      });

      res.status(201).json(playlistTrack);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to add track to playlist' });
    }
  });

  /**
   * DELETE /api/playlists/:id/tracks/:position
   * Remove a track at a specific 1-based position.
   */
  router.delete('/:id/tracks/:position', async (req: Request, res: Response) => {
    if (!playlistManager) {
      res.status(503).json({ error: 'Playlist service unavailable' });
      return;
    }

    try {
      const { id, position } = req.params;
      const pos = parseInt(position, 10);
      if (isNaN(pos) || pos < 1) {
        res.status(400).json({ error: 'Valid 1-based position number is required' });
        return;
      }

      const removed = await playlistManager.removeTrackFromPlaylist(id, pos);
      if (!removed) {
        res.status(404).json({ error: 'Track not found at specified position' });
        return;
      }

      broadcastPlaylistEvent({
        type: 'playlist.track.removed',
        playlistId: id,
        position: pos,
      });

      res.json({ success: true, position: pos });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to remove track from playlist' });
    }
  });

  /**
   * POST /api/playlists/:id/reorder
   * Reorder a track from one position to another.
   */
  router.post('/:id/reorder', async (req: Request, res: Response) => {
    if (!playlistManager) {
      res.status(503).json({ error: 'Playlist service unavailable' });
      return;
    }

    try {
      const { id } = req.params;
      const { fromPosition, toPosition } = req.body;

      if (
        typeof fromPosition !== 'number' ||
        typeof toPosition !== 'number' ||
        fromPosition < 1 ||
        toPosition < 1
      ) {
        res.status(400).json({ error: 'Valid fromPosition and toPosition numbers are required' });
        return;
      }

      const reordered = await playlistManager.reorderPlaylistTrack(id, fromPosition, toPosition);
      if (!reordered) {
        res.status(400).json({ error: 'Failed to reorder playlist track' });
        return;
      }

      broadcastPlaylistEvent({
        type: 'playlist.reordered',
        playlistId: id,
        fromPosition,
        toPosition,
      });

      res.json({ success: true, fromPosition, toPosition });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to reorder playlist track' });
    }
  });

  /**
   * POST /api/playlists/:id/play
   * Enqueue and play an entire playlist in a guild.
   */
  router.post('/:id/play', async (req: Request, res: Response) => {
    if (!playlistManager || !playbackManager) {
      res.status(503).json({ error: 'Playback or Playlist service unavailable' });
      return;
    }

    try {
      const { id } = req.params;
      const { guildId } = req.body;

      if (!guildId) {
        res.status(400).json({ error: 'guildId is required in request body' });
        return;
      }

      const playlistData = await playlistManager.getPlaylist(id);
      if (!playlistData || playlistData.tracks.length === 0) {
        res.status(404).json({ error: 'Playlist is empty or does not exist' });
        return;
      }

      let enqueuedCount = 0;
      let skippedCount = 0;

      for (const pt of playlistData.tracks) {
        if (!pt.source || !pt.source.sourceUrl) {
          skippedCount++;
          continue;
        }

        const trackPath = pt.source.sourceUrl;
        const isStream =
          pt.source.sourceType === 'stream' ||
          trackPath.startsWith('http://') ||
          trackPath.startsWith('https://');

        const queueTrack: QueueTrack = {
          id: pt.id || pt.trackId,
          trackId: pt.trackId,
          name: pt.track?.title || 'Unknown Track',
          path: trackPath,
          duration: pt.track?.duration ?? undefined,
          artist: pt.track?.artist ?? undefined,
          album: pt.track?.album ?? undefined,
          thumbnailUrl: pt.track?.coverArt ?? undefined,
          sourceProvider: pt.source.provider,
          sourceUrl: trackPath,
          source: pt.source.provider,
          artwork: pt.track?.coverArt ?? undefined,
          addedBy: pt.addedBy || 'Playlist',
        };

        const currentTrack = playbackManager.getCurrentTrack(guildId);
        const playerStatus = playbackManager.getPlaybackStatus(guildId);

        if (!currentTrack && playerStatus === 'IDLE' && enqueuedCount === 0) {
          // Play first track immediately
          const audioSource = isStream
            ? new HttpAudioSource(trackPath, {
                title: queueTrack.name,
                artist: queueTrack.artist,
                album: queueTrack.album,
                duration: queueTrack.duration,
              })
            : new LocalAudioSource(trackPath);

          await playbackManager.play(guildId, audioSource, queueTrack);
        } else {
          playbackManager.queueManager.addTrack(guildId, queueTrack);
        }
        enqueuedCount++;
      }

      res.json({
        success: true,
        playlistName: playlistData.playlist.name,
        enqueuedCount,
        skippedCount,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to play playlist' });
    }
  });

  return router;
}
