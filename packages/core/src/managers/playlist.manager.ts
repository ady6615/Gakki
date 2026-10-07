import type { Logger } from 'pino';
import { randomUUID } from 'node:crypto';
import { eq, and, asc, sql, ilike, or } from 'drizzle-orm';
import type { DatabaseClient } from '../database/connection';
import * as schema from '../database/schema';
import type {
  Playlist,
  PlaylistTrack,
  CreatePlaylistInput,
  UpdatePlaylistInput,
  PlaylistVisibility,
} from '../types/playlist';
import { TrackManager } from './track.manager';

export class PlaylistNotFoundError extends Error {
  constructor(identifier: string) {
    super(`Playlist not found: ${identifier}`);
    this.name = 'PlaylistNotFoundError';
  }
}

export class PlaylistPermissionError extends Error {
  constructor(message: string = 'You do not have permission to modify this playlist') {
    super(message);
    this.name = 'PlaylistPermissionError';
  }
}

/**
 * Manages persistent playlists and ordered playlist tracks in PostgreSQL.
 */
export class PlaylistManager {
  // In-memory fallback stores shared across instances in process
  private static readonly sharedPlaylists = new Map<string, Playlist>();
  private static readonly sharedTracks = new Map<string, PlaylistTrack[]>();

  private get inMemoryPlaylists() {
    return PlaylistManager.sharedPlaylists;
  }

  private get inMemoryTracks() {
    return PlaylistManager.sharedTracks;
  }

  constructor(
    private readonly db: DatabaseClient | null,
    private readonly logger: Logger,
    private trackManager?: TrackManager | null,
  ) {
    if (!this.trackManager && this.db) {
      this.trackManager = new TrackManager(this.db);
    }
    this.logger.debug('PlaylistManager initialized');
  }

  setTrackManager(trackManager: TrackManager): void {
    this.trackManager = trackManager;
  }

  /**
   * Create a new playlist.
   */
  async createPlaylist(input: CreatePlaylistInput): Promise<Playlist> {
    const name = input.name.trim();
    if (!name) {
      throw new Error('Playlist name cannot be empty');
    }

    const id = randomUUID();
    const now = new Date();
    const visibility: PlaylistVisibility = input.visibility ?? 'guild';

    if (!this.db) {
      const playlist: Playlist = {
        id,
        name,
        description: input.description ?? null,
        ownerUserId: input.ownerUserId ?? null,
        guildId: input.guildId ?? null,
        visibility,
        trackCount: 0,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      this.inMemoryPlaylists.set(id, playlist);
      this.inMemoryTracks.set(id, []);
      return playlist;
    }

    const inserted = await this.db
      .insert(schema.playlists)
      .values({
        id,
        name,
        description: input.description ?? null,
        ownerUserId: input.ownerUserId ?? null,
        guildId: input.guildId ?? null,
        visibility,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const row = inserted[0];
    this.logger.info({ playlistId: row.id, name: row.name }, '[PLAYLIST] Created playlist');

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      ownerUserId: row.ownerUserId,
      guildId: row.guildId,
      visibility: row.visibility as PlaylistVisibility,
      trackCount: 0,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * Get a playlist with its ordered tracks and track metadata.
   */
  async getPlaylist(playlistId: string): Promise<{ playlist: Playlist; tracks: PlaylistTrack[] } | null> {
    if (!this.db) {
      const playlist = this.inMemoryPlaylists.get(playlistId);
      if (!playlist) return null;
      const tracks = this.inMemoryTracks.get(playlistId) || [];
      return { playlist: { ...playlist, trackCount: tracks.length }, tracks };
    }

    try {
      const playlistRows = await this.db
        .select()
        .from(schema.playlists)
        .where(eq(schema.playlists.id, playlistId))
        .limit(1);

      if (playlistRows.length === 0) {
        // Fallback to in-memory store in case it was created in memory
        const inMem = this.inMemoryPlaylists.get(playlistId);
        if (inMem) {
          const tracks = this.inMemoryTracks.get(playlistId) || [];
          return { playlist: { ...inMem, trackCount: tracks.length }, tracks };
        }
        return null;
      }

      const pRow = playlistRows[0];

      // Fetch tracks ordered by position ascending
      const trackRows = await this.db
        .select({
          pt: schema.playlistTracks,
          t: schema.tracks,
        })
        .from(schema.playlistTracks)
        .innerJoin(schema.tracks, eq(schema.playlistTracks.trackId, schema.tracks.id))
        .where(eq(schema.playlistTracks.playlistId, playlistId))
        .orderBy(asc(schema.playlistTracks.position));

      // Also fetch primary source for each track where available
      const trackIds = trackRows.map((r) => r.t.id);
      const sourcesMap = new Map<string, { provider: string; sourceType: string; sourceUrl: string; externalId: string | null }>();

      if (trackIds.length > 0) {
        const sources = await this.db
          .select()
          .from(schema.trackSources)
          .where(sql`${schema.trackSources.trackId} IN ${trackIds}`);

        for (const s of sources) {
          if (!sourcesMap.has(s.trackId)) {
            sourcesMap.set(s.trackId, {
              provider: s.provider,
              sourceType: s.sourceType,
              sourceUrl: s.sourceUrl,
              externalId: s.externalId,
            });
          }
        }
      }

      const tracks: PlaylistTrack[] = trackRows.map(({ pt, t }) => ({
        id: pt.id,
        playlistId: pt.playlistId,
        trackId: pt.trackId,
        position: pt.position,
        addedBy: pt.addedBy,
        addedAt: pt.addedAt.toISOString(),
        track: {
          id: t.id,
          title: t.title,
          artist: t.artist,
          album: t.album,
          duration: t.duration,
          coverArt: t.coverArt,
        },
        source: sourcesMap.get(t.id) || null,
      }));

      const playlist: Playlist = {
        id: pRow.id,
        name: pRow.name,
        description: pRow.description,
        ownerUserId: pRow.ownerUserId,
        guildId: pRow.guildId,
        visibility: pRow.visibility as PlaylistVisibility,
        trackCount: tracks.length,
        createdAt: pRow.createdAt.toISOString(),
        updatedAt: pRow.updatedAt.toISOString(),
      };

      return { playlist, tracks };
    } catch (err) {
      this.logger.error({ err, playlistId }, 'Failed to get playlist from database, trying in-memory');
      const inMem = this.inMemoryPlaylists.get(playlistId);
      if (inMem) {
        const tracks = this.inMemoryTracks.get(playlistId) || [];
        return { playlist: { ...inMem, trackCount: tracks.length }, tracks };
      }
      return null;
    }
  }

  /**
   * Find a playlist by name accessible to the given user or guild.
   */
  async findPlaylistByName(
    name: string,
    scope: { guildId?: string; userId?: string } = {},
  ): Promise<Playlist | null> {
    const trimmed = name.trim().toLowerCase();
    if (!trimmed) return null;

    if (!this.db) {
      for (const p of this.inMemoryPlaylists.values()) {
        if (p.name.toLowerCase() === trimmed) {
          if (scope.userId && p.ownerUserId === scope.userId) return p;
          if (scope.guildId && p.guildId === scope.guildId) return p;
          if (p.visibility === 'public') return p;
        }
      }
      return null;
    }

    try {
      // Find matching playlists
      const rows = await this.db
        .select()
        .from(schema.playlists)
        .where(ilike(schema.playlists.name, trimmed));

      if (rows.length === 0) return null;

      // Filter by accessibility: User first, then Guild, then Public
      let bestMatch = rows.find((r) => scope.userId && r.ownerUserId === scope.userId);
      if (!bestMatch && scope.guildId) {
        bestMatch = rows.find((r) => r.guildId === scope.guildId && r.visibility !== 'private');
      }
      if (!bestMatch) {
        bestMatch = rows.find((r) => r.visibility === 'public');
      }

      if (!bestMatch) return null;

      return {
        id: bestMatch.id,
        name: bestMatch.name,
        description: bestMatch.description,
        ownerUserId: bestMatch.ownerUserId,
        guildId: bestMatch.guildId,
        visibility: bestMatch.visibility as PlaylistVisibility,
        trackCount: 0,
        createdAt: bestMatch.createdAt.toISOString(),
        updatedAt: bestMatch.updatedAt.toISOString(),
      };
    } catch (err) {
      this.logger.error({ err, name }, 'Failed to find playlist by name');
      return null;
    }
  }

  /**
   * List playlists accessible to the user and guild, partitioned into user and guild playlists.
   */
  async listPlaylists(
    scope: { guildId?: string; userId?: string } = {},
  ): Promise<{ userPlaylists: Playlist[]; guildPlaylists: Playlist[] }> {
    if (!this.db) {
      const userPlaylists: Playlist[] = [];
      const guildPlaylists: Playlist[] = [];

      for (const p of this.inMemoryPlaylists.values()) {
        const count = this.inMemoryTracks.get(p.id)?.length || 0;
        const item: Playlist = { ...p, trackCount: count };

        if (scope.userId && p.ownerUserId === scope.userId) {
          userPlaylists.push(item);
        } else if (scope.guildId && p.guildId === scope.guildId && p.visibility !== 'private') {
          guildPlaylists.push(item);
        } else if (p.visibility === 'public') {
          guildPlaylists.push(item);
        }
      }

      return { userPlaylists, guildPlaylists };
    }

    try {
      const conditions = [];
      if (scope.userId) {
        conditions.push(eq(schema.playlists.ownerUserId, scope.userId));
      }
      if (scope.guildId) {
        conditions.push(
          and(
            eq(schema.playlists.guildId, scope.guildId),
            or(eq(schema.playlists.visibility, 'guild'), eq(schema.playlists.visibility, 'public')),
          ),
        );
      }
      conditions.push(eq(schema.playlists.visibility, 'public'));

      const rows = await this.db
        .select({
          playlist: schema.playlists,
          trackCount: sql<number>`count(${schema.playlistTracks.id})::int`,
        })
        .from(schema.playlists)
        .leftJoin(schema.playlistTracks, eq(schema.playlists.id, schema.playlistTracks.playlistId))
        .where(or(...conditions))
        .groupBy(schema.playlists.id)
        .orderBy(asc(schema.playlists.name));

      const userPlaylists: Playlist[] = [];
      const guildPlaylists: Playlist[] = [];

      for (const { playlist: p, trackCount } of rows) {
        const item: Playlist = {
          id: p.id,
          name: p.name,
          description: p.description,
          ownerUserId: p.ownerUserId,
          guildId: p.guildId,
          visibility: p.visibility as PlaylistVisibility,
          trackCount: Number(trackCount),
          createdAt: p.createdAt.toISOString(),
          updatedAt: p.updatedAt.toISOString(),
        };

        if (scope.userId && p.ownerUserId === scope.userId) {
          userPlaylists.push(item);
        } else {
          guildPlaylists.push(item);
        }
      }

      return { userPlaylists, guildPlaylists };
    } catch (err) {
      this.logger.error({ err, scope }, 'Failed to list playlists');
      return { userPlaylists: [], guildPlaylists: [] };
    }
  }

  /**
   * Add a track to a playlist at the next contiguous position.
   * Duplicates are explicitly allowed.
   */
  async addTrackToPlaylist(
    playlistId: string,
    trackId: string,
    addedBy?: string,
  ): Promise<PlaylistTrack> {
    const id = randomUUID();
    const now = new Date();

    if (!this.db) {
      const tracks = this.inMemoryTracks.get(playlistId) || [];
      const nextPosition = tracks.length + 1;
      let trackObj = {
        id: trackId,
        title: 'Track ' + trackId,
        artist: null as string | null,
        album: null as string | null,
        duration: null as number | null,
        coverArt: null as string | null,
      };

      let sourceObj: any = null;
      if (this.trackManager) {
        const found = await this.trackManager.getTrackById(trackId);
        if (found) {
          trackObj = {
            id: found.id,
            title: found.title,
            artist: found.artist,
            album: found.album,
            duration: found.duration,
            coverArt: found.coverArt,
          };
        }
        const src = await this.trackManager.getPrimarySourceByTrackId(trackId);
        if (src) {
          sourceObj = {
            provider: src.provider,
            sourceType: src.sourceType,
            sourceUrl: src.sourceUrl,
            externalId: src.externalId,
          };
        }
      } else {
        const found = TrackManager.getSharedTrackById(trackId);
        if (found) {
          trackObj = {
            id: found.id,
            title: found.title,
            artist: found.artist,
            album: found.album,
            duration: found.duration,
            coverArt: found.coverArt,
          };
        }
        const src = TrackManager.getSharedSourceByTrackId(trackId);
        if (src) {
          sourceObj = {
            provider: src.provider,
            sourceType: src.sourceType,
            sourceUrl: src.sourceUrl,
            externalId: src.externalId,
          };
        }
      }

      const pt: PlaylistTrack = {
        id,
        playlistId,
        trackId,
        position: nextPosition,
        addedBy: addedBy ?? null,
        addedAt: now.toISOString(),
        track: trackObj,
        source: sourceObj,
      };
      tracks.push(pt);
      this.inMemoryTracks.set(playlistId, tracks);
      return pt;
    }

    // Determine current maximum position
    const maxPosRes = await this.db
      .select({ maxPos: sql<number>`COALESCE(MAX(${schema.playlistTracks.position}), 0)::int` })
      .from(schema.playlistTracks)
      .where(eq(schema.playlistTracks.playlistId, playlistId));

    const nextPosition = (maxPosRes[0]?.maxPos ?? 0) + 1;

    // Insert track
    const inserted = await this.db
      .insert(schema.playlistTracks)
      .values({
        id,
        playlistId,
        trackId,
        position: nextPosition,
        addedBy: addedBy ?? null,
        addedAt: now,
      })
      .returning();

    // Touch playlist updated_at
    await this.db
      .update(schema.playlists)
      .set({ updatedAt: now })
      .where(eq(schema.playlists.id, playlistId));

    // Fetch track info for return
    const trackInfo = await this.db
      .select()
      .from(schema.tracks)
      .where(eq(schema.tracks.id, trackId))
      .limit(1);

    const t = trackInfo[0];
    this.logger.info(
      { playlistId, trackId, position: nextPosition },
      '[PLAYLIST] Added track to playlist',
    );

    return {
      id: inserted[0].id,
      playlistId,
      trackId,
      position: nextPosition,
      addedBy: inserted[0].addedBy,
      addedAt: inserted[0].addedAt.toISOString(),
      track: t
        ? {
            id: t.id,
            title: t.title,
            artist: t.artist,
            album: t.album,
            duration: t.duration,
            coverArt: t.coverArt,
          }
        : undefined,
    };
  }

  /**
   * Remove a track at a specific 1-based position and compact subsequent positions.
   */
  async removeTrackFromPlaylist(playlistId: string, position: number): Promise<boolean> {
    if (position < 1) return false;

    if (!this.db) {
      const tracks = this.inMemoryTracks.get(playlistId) || [];
      const index = tracks.findIndex((t) => t.position === position);
      if (index === -1) return false;
      tracks.splice(index, 1);
      // Re-index remaining
      for (let i = 0; i < tracks.length; i++) {
        tracks[i].position = i + 1;
      }
      return true;
    }

    try {
      // 1. Delete track at position
      const del = await this.db
        .delete(schema.playlistTracks)
        .where(
          and(
            eq(schema.playlistTracks.playlistId, playlistId),
            eq(schema.playlistTracks.position, position),
          ),
        )
        .returning();

      if (del.length === 0) {
        return false;
      }

      // 2. Compact all positions greater than deleted position
      await this.db.execute(sql`
        UPDATE playlist_tracks
        SET position = position - 1
        WHERE playlist_id = ${playlistId} AND position > ${position}
      `);

      // Touch playlist
      await this.db
        .update(schema.playlists)
        .set({ updatedAt: new Date() })
        .where(eq(schema.playlists.id, playlistId));

      this.logger.info({ playlistId, position }, '[PLAYLIST] Removed track at position');
      return true;
    } catch (err) {
      this.logger.error({ err, playlistId, position }, 'Failed to remove track from playlist');
      return false;
    }
  }

  /**
   * Reorder a track from fromPosition to toPosition deterministically.
   */
  async reorderPlaylistTrack(
    playlistId: string,
    fromPosition: number,
    toPosition: number,
  ): Promise<boolean> {
    if (fromPosition === toPosition || fromPosition < 1 || toPosition < 1) {
      return false;
    }

    if (!this.db) {
      const tracks = this.inMemoryTracks.get(playlistId) || [];
      const itemIndex = tracks.findIndex((t) => t.position === fromPosition);
      if (itemIndex === -1) return false;
      const [item] = tracks.splice(itemIndex, 1);
      tracks.splice(toPosition - 1, 0, item);
      for (let i = 0; i < tracks.length; i++) {
        tracks[i].position = i + 1;
      }
      return true;
    }

    try {
      // 1. Move target item to temporary position -1
      const updateTarget = await this.db.execute(sql`
        UPDATE playlist_tracks
        SET position = -1
        WHERE playlist_id = ${playlistId} AND position = ${fromPosition}
      `);

      if ((updateTarget as any)?.rowCount === 0) {
        return false;
      }

      // 2. Shift items between fromPosition and toPosition
      if (fromPosition < toPosition) {
        // Moving down: shift items between fromPosition+1 and toPosition UP (decrement position)
        await this.db.execute(sql`
          UPDATE playlist_tracks
          SET position = position - 1
          WHERE playlist_id = ${playlistId}
            AND position > ${fromPosition}
            AND position <= ${toPosition}
        `);
      } else {
        // Moving up: shift items between toPosition and fromPosition-1 DOWN (increment position)
        await this.db.execute(sql`
          UPDATE playlist_tracks
          SET position = position + 1
          WHERE playlist_id = ${playlistId}
            AND position >= ${toPosition}
            AND position < ${fromPosition}
        `);
      }

      // 3. Move target item from -1 to toPosition
      await this.db.execute(sql`
        UPDATE playlist_tracks
        SET position = ${toPosition}
        WHERE playlist_id = ${playlistId} AND position = -1
      `);

      // Touch playlist
      await this.db
        .update(schema.playlists)
        .set({ updatedAt: new Date() })
        .where(eq(schema.playlists.id, playlistId));

      this.logger.info(
        { playlistId, fromPosition, toPosition },
        '[PLAYLIST] Reordered track position',
      );
      return true;
    } catch (err) {
      this.logger.error({ err, playlistId, fromPosition, toPosition }, 'Failed to reorder playlist track');
      return false;
    }
  }

  /**
   * Rename a playlist with permission verification.
   */
  async renamePlaylist(playlistId: string, newName: string, userId?: string): Promise<Playlist> {
    const trimmed = newName.trim();
    if (!trimmed) {
      throw new Error('Playlist name cannot be empty');
    }

    if (!this.db) {
      const p = this.inMemoryPlaylists.get(playlistId);
      if (!p) throw new PlaylistNotFoundError(playlistId);
      if (p.ownerUserId && userId && p.ownerUserId !== userId) {
        throw new PlaylistPermissionError();
      }
      p.name = trimmed;
      p.updatedAt = new Date().toISOString();
      return p;
    }

    const existing = await this.db
      .select()
      .from(schema.playlists)
      .where(eq(schema.playlists.id, playlistId))
      .limit(1);

    if (existing.length === 0) {
      throw new PlaylistNotFoundError(playlistId);
    }

    const p = existing[0];
    if (p.ownerUserId && userId && p.ownerUserId !== userId) {
      throw new PlaylistPermissionError();
    }

    const updated = await this.db
      .update(schema.playlists)
      .set({ name: trimmed, updatedAt: new Date() })
      .where(eq(schema.playlists.id, playlistId))
      .returning();

    return {
      id: updated[0].id,
      name: updated[0].name,
      description: updated[0].description,
      ownerUserId: updated[0].ownerUserId,
      guildId: updated[0].guildId,
      visibility: updated[0].visibility as PlaylistVisibility,
      trackCount: 0,
      createdAt: updated[0].createdAt.toISOString(),
      updatedAt: updated[0].updatedAt.toISOString(),
    };
  }

  /**
   * Delete a playlist and its track references with permission check.
   */
  async deletePlaylist(playlistId: string, userId?: string): Promise<boolean> {
    if (!this.db) {
      const p = this.inMemoryPlaylists.get(playlistId);
      if (!p) return false;
      if (p.ownerUserId && userId && p.ownerUserId !== userId) {
        throw new PlaylistPermissionError();
      }
      this.inMemoryPlaylists.delete(playlistId);
      this.inMemoryTracks.delete(playlistId);
      return true;
    }

    try {
      const existing = await this.db
        .select()
        .from(schema.playlists)
        .where(eq(schema.playlists.id, playlistId))
        .limit(1);

      if (existing.length === 0) return false;

      const p = existing[0];
      if (p.ownerUserId && userId && p.ownerUserId !== userId) {
        throw new PlaylistPermissionError();
      }

      await this.db.delete(schema.playlists).where(eq(schema.playlists.id, playlistId));
      this.logger.info({ playlistId }, '[PLAYLIST] Deleted playlist');
      return true;
    } catch (err) {
      if (err instanceof PlaylistPermissionError) throw err;
      this.logger.error({ err, playlistId }, 'Failed to delete playlist');
      return false;
    }
  }

  /**
   * Batch reorder playlist tracks in a single authoritative operation (Requirement 8).
   * @param playlistId - ID of playlist
   * @param orderedItemIds - Array of playlist_tracks IDs in new desired order
   */
  async reorderTracksBatch(
    playlistId: string,
    orderedItemIds: string[],
    userId?: string
  ): Promise<PlaylistTrack[]> {
    if (!orderedItemIds || orderedItemIds.length === 0) {
      const res = await this.getPlaylist(playlistId);
      return res ? res.tracks : [];
    }

    if (!this.db) {
      const p = this.inMemoryPlaylists.get(playlistId);
      if (!p) throw new PlaylistNotFoundError(playlistId);
      if (p.ownerUserId && userId && p.ownerUserId !== userId) {
        throw new PlaylistPermissionError();
      }

      const tracks = this.inMemoryTracks.get(playlistId) || [];
      const trackMap = new Map<string, PlaylistTrack>();
      for (const t of tracks) {
        if (t.id) trackMap.set(t.id, t);
        if (t.trackId) trackMap.set(t.trackId, t);
      }
      const reordered: PlaylistTrack[] = [];

      for (let i = 0; i < orderedItemIds.length; i++) {
        const item = trackMap.get(orderedItemIds[i]);
        if (item && !reordered.some((r) => r.trackId === item.trackId)) {
          item.position = i + 1;
          reordered.push(item);
        }
      }

      // Add any leftover items not in the list
      for (const t of tracks) {
        if (!reordered.some((r) => r.trackId === t.trackId)) {
          t.position = reordered.length + 1;
          reordered.push(t);
        }
      }

      this.inMemoryTracks.set(playlistId, reordered);
      return reordered;
    }

    // Verify permission
    const existing = await this.db
      .select()
      .from(schema.playlists)
      .where(eq(schema.playlists.id, playlistId))
      .limit(1);

    if (existing.length === 0) {
      throw new PlaylistNotFoundError(playlistId);
    }

    const p = existing[0];
    if (p.ownerUserId && userId && p.ownerUserId !== userId) {
      throw new PlaylistPermissionError();
    }

    try {
      // Execute batch reorder in a single atomic operation
      for (let i = 0; i < orderedItemIds.length; i++) {
        await this.db.execute(sql`
          UPDATE playlist_tracks
          SET position = ${i + 1}
          WHERE playlist_id = ${playlistId}::uuid
            AND (id::text = ${orderedItemIds[i]} OR track_id::text = ${orderedItemIds[i]})
        `);
      }

      await this.db
        .update(schema.playlists)
        .set({ updatedAt: new Date() })
        .where(eq(schema.playlists.id, playlistId));

      const updated = await this.getPlaylist(playlistId);
      return updated ? updated.tracks : [];
    } catch (err) {
      this.logger.error({ err, playlistId }, 'Failed to batch reorder playlist tracks');
      throw err;
    }
  }

  /**
   * Duplicate an existing playlist and all its tracks (Requirement 7).
   */
  async duplicatePlaylist(
    playlistId: string,
    arg2: string,
    arg3?: string
  ): Promise<Playlist> {
    let newName = arg2;
    let userId = arg3;

    // Handle flexible argument order: (id, name, userId) vs (id, userId, name)
    if (arg3) {
      if (arg3.includes(' ') || arg3.length > arg2.length) {
        newName = arg3;
        userId = arg2;
      }
    }

    const trimmed = newName.trim();
    if (!trimmed) {
      throw new Error('New playlist name cannot be empty');
    }

    const original = await this.getPlaylist(playlistId);
    if (!original) {
      throw new PlaylistNotFoundError(playlistId);
    }

    // Create new playlist
    const newPlaylist = await this.createPlaylist({
      name: trimmed,
      description: original.playlist.description
        ? `Copy of ${original.playlist.name}: ${original.playlist.description}`
        : `Copy of ${original.playlist.name}`,
      ownerUserId: userId || original.playlist.ownerUserId || undefined,
      guildId: original.playlist.guildId || undefined,
      visibility: original.playlist.visibility,
    });

    // Copy all tracks
    for (const item of original.tracks) {
      await this.addTrackToPlaylist(newPlaylist.id, item.trackId, userId || item.addedBy || undefined);
    }

    newPlaylist.trackCount = original.tracks.length;
    return newPlaylist;
  }

  /**
   * Save or update an external playlist (e.g., imported from Spotify or YouTube)
   * with all its tracks, metadata, and genres persisted in PostgreSQL.
   */
  async saveExternalPlaylist(input: {
    name: string;
    description?: string;
    guildId?: string;
    ownerUserId?: string;
    tracks: Array<{
      title: string;
      artist?: string;
      album?: string;
      duration?: number;
      sourceUrl?: string;
      provider?: string;
      genre?: string;
      thumbnailUrl?: string;
    }>;
  }): Promise<Playlist> {
    const name = input.name.trim();
    if (!name) {
      throw new Error('Playlist name cannot be empty');
    }

    // Find if playlist already exists for this guild/user
    let playlist = await this.findPlaylistByName(name, {
      guildId: input.guildId,
      userId: input.ownerUserId,
    });

    if (!playlist) {
      playlist = await this.createPlaylist({
        name,
        description: input.description ?? 'Imported playlist',
        guildId: input.guildId,
        ownerUserId: input.ownerUserId,
        visibility: input.guildId ? 'guild' : 'public',
      });
    }

    // Clear existing tracks if updating
    if (!this.db) {
      this.inMemoryTracks.set(playlist.id, []);
    } else {
      await this.db.delete(schema.playlistTracks).where(eq(schema.playlistTracks.playlistId, playlist.id));
    }

    const tm = this.trackManager || new TrackManager(this.db);

    // Persist each track and add to playlist
    for (const t of input.tracks) {
      try {
        const saved = await tm.saveTrackWithSource(
          {
            title: t.title,
            artist: t.artist ?? null,
            album: t.album ?? null,
            duration: t.duration ?? null,
            thumbnailUrl: t.thumbnailUrl ?? null,
            genre: t.genre ?? null,
          },
          {
            provider: t.provider || 'spotify',
            sourceType: 'stream',
            sourceUrl: t.sourceUrl || '',
          },
        );
        if (saved?.track?.id) {
          await this.addTrackToPlaylist(playlist.id, saved.track.id, input.ownerUserId);
        }
      } catch (trackErr) {
        this.logger.warn({ trackErr, title: t.title }, 'Failed to save track in external playlist');
      }
    }

    playlist.trackCount = input.tracks.length;
    return playlist;
  }

  /**
   * Automatically generate or sync the dynamic "🔥 Most Played" playlist for a guild
   * based on historical playback analytics.
   */
  async syncMostPlayedPlaylist(
    guildId: string,
    analyticsManager?: any,
    limit: number = 25,
  ): Promise<Playlist> {
    const playlistName = '🔥 Most Played';
    let playlist = await this.findPlaylistByName(playlistName, { guildId });

    if (!playlist) {
      playlist = await this.createPlaylist({
        name: playlistName,
        description: 'Auto-generated playlist of the most played songs in this server',
        guildId,
        visibility: 'guild',
      });
    }

    // Clear old tracks in the most played playlist
    if (!this.db) {
      this.inMemoryTracks.set(playlist.id, []);
    } else {
      await this.db.delete(schema.playlistTracks).where(eq(schema.playlistTracks.playlistId, playlist.id));
    }

    // Fetch top tracks from analytics if available
    let topTracks: Array<{ trackId?: string; title?: string; artist?: string | null }> = [];
    if (analyticsManager) {
      const stats = await analyticsManager.getDashboardStats({ guildId, timeRange: 'all' });
      topTracks = (stats.topTracks || stats.mostPlayedTracks || []).slice(0, limit);
    }

    const tm = this.trackManager || (this.db ? new TrackManager(this.db) : null);
    let count = 0;
    for (const t of topTracks) {
      let trackId = t.trackId;
      if (!trackId && t.title && tm) {
        try {
          const saved = await tm.saveTrackWithSource(
            { title: t.title, artist: t.artist ?? null },
            { provider: 'youtube', sourceType: 'stream', sourceUrl: t.title },
          );
          trackId = saved.track.id;
        } catch {
          // ignore
        }
      }
      if (trackId) {
        await this.addTrackToPlaylist(playlist.id, trackId);
        count++;
      }
    }

    playlist.trackCount = count;
    return playlist;
  }
}

