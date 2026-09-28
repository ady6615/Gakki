import type { Logger } from 'pino';
import { randomUUID } from 'node:crypto';
import { eq, and, desc, sql, lt } from 'drizzle-orm';
import type { DatabaseClient } from '../database/connection';
import * as schema from '../database/schema';

export type PlaybackEndReason = 'finished' | 'skipped' | 'stopped' | 'error';

export interface PlaybackStartParams {
  eventId?: string;
  guildId: string;
  trackId: string;
  userId?: string | null;
  source?: string | null;
  trackDuration?: number | null;
  sessionId?: string | null;
  startedAt?: Date;
  trackTitle?: string | null;
  artist?: string | null;
}

export interface PlaybackEndParams {
  endedAt?: Date;
  durationListened: number;
  completed: boolean;
  endReason: PlaybackEndReason;
}

export interface PlaybackHistoryItem {
  id: string;
  guildId: string;
  trackId: string;
  userId: string | null;
  startedAt: Date;
  endedAt: Date | null;
  durationListened: number;
  trackDuration: number | null;
  completed: boolean;
  endReason: string | null;
  source: string | null;
  sessionId: string | null;
  track: {
    id: string;
    title: string;
    artist: string | null;
    album: string | null;
    coverArt: string | null;
  };
}

export interface TrackStatistics {
  trackId: string;
  playCount: number;
  completionCount: number;
  skipCount: number;
  totalListeningTime: number; // in seconds
  uniqueListeners: number;
}

export interface GuildAnalytics {
  guildId: string;
  totalTracksPlayed: number;
  totalListeningTime: number; // in seconds
  completionRate: number; // 0.0 to 1.0
  skipRate: number; // 0.0 to 1.0
  uniqueUsers: number;
  uniqueTracks: number;
  topTracks: Array<{
    trackId: string;
    title: string;
    artist: string | null;
    playCount: number;
    totalListeningTime: number;
  }>;
  topArtists: Array<{
    artist: string;
    playCount: number;
    totalListeningTime: number;
  }>;
}

import { TrackManager } from './track.manager';

/**
 * Manages persistent playback events, history queries, and SQL-aggregated analytics.
 */
export class AnalyticsManager {
  // In-memory fallback event cache for tests or when DB is unavailable
  private static readonly sharedEvents = new Map<string, any>();

  private get inMemoryEvents() {
    return AnalyticsManager.sharedEvents;
  }

  constructor(
    private readonly db: DatabaseClient | null,
    private readonly logger: Logger,
    private trackManager?: TrackManager | null,
  ) {
    this.logger.debug('AnalyticsManager initialized');
  }

  setTrackManager(trackManager: TrackManager): void {
    this.trackManager = trackManager;
  }

  /**
   * Record the start of a track playback event.
   * Single track playback instance maps to one logical history event.
   */
  async recordPlaybackStart(params: PlaybackStartParams): Promise<string> {
    const eventId = params.eventId || randomUUID();
    const startedAt = params.startedAt || new Date();

    if (!this.db) {
      let trackTitle = params.trackTitle ?? null;
      let artist = params.artist ?? null;
      if (!trackTitle || !artist) {
        if (this.trackManager) {
          const found = await this.trackManager.getTrackById(params.trackId);
          if (found) {
            trackTitle = trackTitle || found.title;
            artist = artist || found.artist;
          }
        } else {
          const found = TrackManager.getSharedTrackById(params.trackId);
          if (found) {
            trackTitle = trackTitle || found.title;
            artist = artist || found.artist;
          }
        }
      }

      this.inMemoryEvents.set(eventId, {
        id: eventId,
        guildId: params.guildId,
        trackId: params.trackId,
        userId: params.userId ?? null,
        startedAt,
        endedAt: null,
        durationListened: 0,
        trackDuration: params.trackDuration ?? null,
        completed: false,
        endReason: null,
        source: params.source ?? null,
        sessionId: params.sessionId ?? null,
        createdAt: startedAt,
        trackTitle,
        artist,
      });
      return eventId;
    }

    try {
      await this.db.insert(schema.playbackEvents).values({
        id: eventId,
        guildId: params.guildId,
        trackId: params.trackId,
        userId: params.userId ?? null,
        platform: 'discord',
        startedAt,
        endedAt: null,
        durationListened: 0,
        trackDuration: params.trackDuration ?? null,
        completed: false,
        endReason: null,
        source: params.source ?? null,
        sessionId: params.sessionId ?? null,
        createdAt: startedAt,
      });

      this.logger.info(
        { eventId, guildId: params.guildId, trackId: params.trackId, sessionId: params.sessionId },
        '[ANALYTICS] Playback event started',
      );
      return eventId;
    } catch (err) {
      this.logger.error({ err, eventId }, 'Failed to record playback start event in PostgreSQL');
      return eventId;
    }
  }

  /**
   * Finalize a playback event with accurate listened duration and completion status.
   */
  async recordPlaybackEnd(eventId: string, params: PlaybackEndParams): Promise<void> {
    const endedAt = params.endedAt || new Date();
    const durationListened = Math.max(0, Math.round(params.durationListened));

    if (!this.db) {
      const existing = this.inMemoryEvents.get(eventId);
      if (existing) {
        existing.endedAt = endedAt;
        existing.durationListened = durationListened;
        existing.completed = params.completed;
        existing.endReason = params.endReason;
      }
      return;
    }

    try {
      await this.db
        .update(schema.playbackEvents)
        .set({
          endedAt,
          durationListened,
          completed: params.completed,
          endReason: params.endReason,
        })
        .where(eq(schema.playbackEvents.id, eventId));

      this.logger.info(
        { eventId, durationListened, completed: params.completed, endReason: params.endReason },
        '[ANALYTICS] Playback event finalized',
      );
    } catch (err) {
      this.logger.error({ err, eventId }, 'Failed to finalize playback event in PostgreSQL');
    }
  }

  /**
   * Fetch recent playback history for a guild, joined with track metadata.
   */
  async getGuildHistory(
    guildId: string,
    options: {
      limit?: number;
      offset?: number;
      completed?: boolean;
      userId?: string;
      trackId?: string;
      source?: string;
    } = {},
  ): Promise<{ events: PlaybackHistoryItem[]; total: number }> {
    const limit = Math.min(100, Math.max(1, options.limit ?? 20));
    const offset = Math.max(0, options.offset ?? 0);

    if (!this.db) {
      const events: PlaybackHistoryItem[] = Array.from(this.inMemoryEvents.values())
        .filter((e) => e.guildId === guildId)
        .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
        .slice(offset, offset + limit)
        .map((e) => ({
          ...e,
          track: {
            id: e.trackId,
            title: e.trackTitle || ('Track ' + e.trackId),
            artist: e.artist ?? null,
            album: null,
            coverArt: null,
          },
        }));
      return { events, total: events.length };
    }

    try {
      // Build conditions
      const conditions = [eq(schema.playbackEvents.guildId, guildId)];
      if (options.completed !== undefined) {
        conditions.push(eq(schema.playbackEvents.completed, options.completed));
      }
      if (options.userId) {
        conditions.push(eq(schema.playbackEvents.userId, options.userId));
      }
      if (options.trackId) {
        conditions.push(eq(schema.playbackEvents.trackId, options.trackId));
      }
      if (options.source) {
        conditions.push(eq(schema.playbackEvents.source, options.source));
      }

      const rows = await this.db
        .select({
          event: schema.playbackEvents,
          track: schema.tracks,
        })
        .from(schema.playbackEvents)
        .innerJoin(schema.tracks, eq(schema.playbackEvents.trackId, schema.tracks.id))
        .where(and(...conditions))
        .orderBy(desc(schema.playbackEvents.startedAt))
        .limit(limit)
        .offset(offset);

      // Count total matching
      const totalResult = await this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.playbackEvents)
        .where(and(...conditions));
      const total = totalResult[0]?.count ?? rows.length;

      const events: PlaybackHistoryItem[] = rows.map(({ event, track }) => ({
        id: event.id,
        guildId: event.guildId!,
        trackId: event.trackId,
        userId: event.userId,
        startedAt: event.startedAt,
        endedAt: event.endedAt,
        durationListened: event.durationListened,
        trackDuration: event.trackDuration,
        completed: event.completed,
        endReason: event.endReason,
        source: event.source,
        sessionId: event.sessionId,
        track: {
          id: track.id,
          title: track.title,
          artist: track.artist,
          album: track.album,
          coverArt: track.coverArt,
        },
      }));

      return { events, total };
    } catch (err) {
      this.logger.error({ err, guildId }, 'Failed to fetch guild history');
      return { events: [], total: 0 };
    }
  }

  /**
   * Fetch recent playback history for a user, respecting privacy.
   */
  async getUserHistory(
    userId: string,
    options: { limit?: number; offset?: number; guildId?: string } = {},
  ): Promise<{ events: PlaybackHistoryItem[]; total: number }> {
    const limit = Math.min(100, Math.max(1, options.limit ?? 20));
    const offset = Math.max(0, options.offset ?? 0);

    if (!this.db) {
      let filtered = Array.from(this.inMemoryEvents.values())
        .filter((e) => e.userId === userId);
      if (options.guildId) {
        filtered = filtered.filter((e) => e.guildId === options.guildId);
      }
      const events: PlaybackHistoryItem[] = filtered
        .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
        .slice(offset, offset + limit)
        .map((e) => ({
          ...e,
          track: {
            id: e.trackId,
            title: e.trackTitle || ('Track ' + e.trackId),
            artist: e.artist ?? null,
            album: null,
            coverArt: null,
          },
        }));
      return { events, total: filtered.length };
    }

    try {
      const conditions = [eq(schema.playbackEvents.userId, userId)];
      if (options.guildId) {
        conditions.push(eq(schema.playbackEvents.guildId, options.guildId));
      }

      const rows = await this.db
        .select({
          event: schema.playbackEvents,
          track: schema.tracks,
        })
        .from(schema.playbackEvents)
        .innerJoin(schema.tracks, eq(schema.playbackEvents.trackId, schema.tracks.id))
        .where(and(...conditions))
        .orderBy(desc(schema.playbackEvents.startedAt))
        .limit(limit)
        .offset(offset);

      const events: PlaybackHistoryItem[] = rows.map(({ event, track }) => ({
        id: event.id,
        guildId: event.guildId!,
        trackId: event.trackId,
        userId: event.userId,
        startedAt: event.startedAt,
        endedAt: event.endedAt,
        durationListened: event.durationListened,
        trackDuration: event.trackDuration,
        completed: event.completed,
        endReason: event.endReason,
        source: event.source,
        sessionId: event.sessionId,
        track: {
          id: track.id,
          title: track.title,
          artist: track.artist,
          album: track.album,
          coverArt: track.coverArt,
        },
      }));

      return { events, total: events.length };
    } catch (err) {
      this.logger.error({ err, userId }, 'Failed to fetch user history');
      return { events: [], total: 0 };
    }
  }

  /**
   * Fetch most recently played distinct tracks for /recent command.
   */
  async getRecentTracks(
    guildId: string,
    limit: number = 10,
  ): Promise<
    Array<{
      trackId: string;
      title: string;
      artist: string | null;
      lastPlayedAt: Date;
      endReason: string | null;
      durationListened: number;
    }>
  > {
    const clampedLimit = Math.min(25, Math.max(1, limit));

    if (!this.db) {
      const seen = new Set<string>();
      const results: Array<{
        trackId: string;
        title: string;
        artist: string | null;
        lastPlayedAt: Date;
        endReason: string | null;
        durationListened: number;
      }> = [];
      const events = Array.from(this.inMemoryEvents.values())
        .filter((e) => e.guildId === guildId)
        .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

      for (const e of events) {
        if (!seen.has(e.trackId)) {
          seen.add(e.trackId);
          results.push({
            trackId: e.trackId,
            title: e.trackTitle || ('Track ' + e.trackId),
            artist: e.artist ?? null,
            lastPlayedAt: e.startedAt,
            endReason: e.endReason,
            durationListened: e.durationListened,
          });
          if (results.length >= clampedLimit) break;
        }
      }
      return results;
    }

    try {
      const results = await this.db.execute<{
        track_id: string;
        title: string;
        artist: string | null;
        last_played_at: Date;
        end_reason: string | null;
        duration_listened: number;
      }>(sql`
        SELECT DISTINCT ON (pe.track_id)
          pe.track_id,
          t.title,
          t.artist,
          pe.started_at AS last_played_at,
          pe.end_reason,
          pe.duration_listened
        FROM playback_events pe
        JOIN tracks t ON pe.track_id = t.id
        WHERE pe.guild_id = ${guildId}
        ORDER BY pe.track_id, pe.started_at DESC
        LIMIT ${clampedLimit}
      `);

      // Sort by last_played_at descending
      const rows = results.rows.sort(
        (a, b) => new Date(b.last_played_at).getTime() - new Date(a.last_played_at).getTime(),
      );

      return rows.map((r) => ({
        trackId: r.track_id,
        title: r.title,
        artist: r.artist,
        lastPlayedAt: new Date(r.last_played_at),
        endReason: r.end_reason,
        durationListened: r.duration_listened,
      }));
    } catch (err) {
      this.logger.error({ err, guildId }, 'Failed to fetch recent tracks');
      return [];
    }
  }

  /**
   * Aggregate statistics for a specific track from playback_events.
   */
  async getTrackStatistics(trackId: string): Promise<TrackStatistics> {
    if (!this.db) {
      const events = Array.from(this.inMemoryEvents.values()).filter((e) => e.trackId === trackId);
      const playCount = events.length;
      const completionCount = events.filter((e) => e.completed).length;
      const skipCount = events.filter((e) => e.endReason === 'skipped').length;
      const totalListeningTime = events.reduce((sum, e) => sum + (e.durationListened || 0), 0);
      const uniqueListeners = new Set(events.map((e) => e.userId).filter(Boolean)).size;
      return {
        trackId,
        playCount,
        completionCount,
        skipCount,
        totalListeningTime,
        uniqueListeners,
      };
    }

    try {
      const res = await this.db.execute<{
        play_count: number;
        completion_count: number;
        skip_count: number;
        total_listening_time: number;
        unique_listeners: number;
      }>(sql`
        SELECT
          COUNT(*)::int AS play_count,
          COUNT(*) FILTER (WHERE completed = true)::int AS completion_count,
          COUNT(*) FILTER (WHERE end_reason = 'skipped')::int AS skip_count,
          COALESCE(SUM(duration_listened), 0)::int AS total_listening_time,
          COUNT(DISTINCT user_id)::int AS unique_listeners
        FROM playback_events
        WHERE track_id = ${trackId}
      `);

      const row = res.rows[0];
      return {
        trackId,
        playCount: row ? Number(row.play_count) : 0,
        completionCount: row ? Number(row.completion_count) : 0,
        skipCount: row ? Number(row.skip_count) : 0,
        totalListeningTime: row ? Number(row.total_listening_time) : 0,
        uniqueListeners: row ? Number(row.unique_listeners) : 0,
      };
    } catch (err) {
      this.logger.error({ err, trackId }, 'Failed to fetch track statistics');
      return {
        trackId,
        playCount: 0,
        completionCount: 0,
        skipCount: 0,
        totalListeningTime: 0,
        uniqueListeners: 0,
      };
    }
  }

  /**
   * Aggregate guild-level analytics using PostgreSQL aggregations.
   * Does NOT load raw tables into Node memory.
   */
  async getGuildAnalytics(guildId: string): Promise<GuildAnalytics> {
    if (!this.db) {
      const events = Array.from(this.inMemoryEvents.values()).filter((e) => e.guildId === guildId);
      const totalTracksPlayed = events.length;
      const totalListeningTime = events.reduce((sum, e) => sum + (e.durationListened || 0), 0);
      const completedPlays = events.filter((e) => e.completed).length;
      const skippedPlays = events.filter((e) => e.endReason === 'skipped').length;
      const completionRate = totalTracksPlayed > 0 ? Math.round((completedPlays / totalTracksPlayed) * 1000) / 1000 : 0;
      const skipRate = totalTracksPlayed > 0 ? Math.round((skippedPlays / totalTracksPlayed) * 1000) / 1000 : 0;
      const uniqueUsers = new Set(events.map((e) => e.userId).filter(Boolean)).size;
      const uniqueTracks = new Set(events.map((e) => e.trackId)).size;

      // Top tracks
      const trackMap = new Map<string, { trackId: string; title: string; artist: string | null; playCount: number; totalListeningTime: number }>();
      for (const e of events) {
        const existing = trackMap.get(e.trackId) || {
          trackId: e.trackId,
          title: e.trackTitle || ('Track ' + e.trackId),
          artist: e.artist ?? null,
          playCount: 0,
          totalListeningTime: 0,
        };
        existing.playCount++;
        existing.totalListeningTime += (e.durationListened || 0);
        trackMap.set(e.trackId, existing);
      }
      const topTracks = Array.from(trackMap.values()).sort((a, b) => b.playCount - a.playCount).slice(0, 5);

      // Top artists
      const artistMap = new Map<string, { artist: string; playCount: number; totalListeningTime: number }>();
      for (const e of events) {
        if (!e.artist) continue;
        const existing = artistMap.get(e.artist) || {
          artist: e.artist,
          playCount: 0,
          totalListeningTime: 0,
        };
        existing.playCount++;
        existing.totalListeningTime += (e.durationListened || 0);
        artistMap.set(e.artist, existing);
      }
      const topArtists = Array.from(artistMap.values()).sort((a, b) => b.playCount - a.playCount).slice(0, 5);

      return {
        guildId,
        totalTracksPlayed,
        totalListeningTime,
        completionRate,
        skipRate,
        uniqueUsers,
        uniqueTracks,
        topTracks,
        topArtists,
      };
    }

    try {
      // 1. Overall totals and rates
      const overallRes = await this.db.execute<{
        total_plays: number;
        total_listening_time: number;
        completed_plays: number;
        skipped_plays: number;
        unique_users: number;
        unique_tracks: number;
      }>(sql`
        SELECT
          COUNT(*)::int AS total_plays,
          COALESCE(SUM(duration_listened), 0)::int AS total_listening_time,
          COUNT(*) FILTER (WHERE completed = true)::int AS completed_plays,
          COUNT(*) FILTER (WHERE end_reason = 'skipped')::int AS skipped_plays,
          COUNT(DISTINCT user_id)::int AS unique_users,
          COUNT(DISTINCT track_id)::int AS unique_tracks
        FROM playback_events
        WHERE guild_id = ${guildId}
      `);

      const overall = overallRes.rows[0] ?? {
        total_plays: 0,
        total_listening_time: 0,
        completed_plays: 0,
        skipped_plays: 0,
        unique_users: 0,
        unique_tracks: 0,
      };

      const totalPlays = Number(overall.total_plays);
      const completionRate = totalPlays > 0 ? Number(overall.completed_plays) / totalPlays : 0;
      const skipRate = totalPlays > 0 ? Number(overall.skipped_plays) / totalPlays : 0;

      // 2. Top tracks in guild
      const topTracksRes = await this.db.execute<{
        track_id: string;
        title: string;
        artist: string | null;
        play_count: number;
        total_listening_time: number;
      }>(sql`
        SELECT
          pe.track_id,
          t.title,
          t.artist,
          COUNT(*)::int AS play_count,
          COALESCE(SUM(pe.duration_listened), 0)::int AS total_listening_time
        FROM playback_events pe
        JOIN tracks t ON pe.track_id = t.id
        WHERE pe.guild_id = ${guildId}
        GROUP BY pe.track_id, t.title, t.artist
        ORDER BY play_count DESC, total_listening_time DESC
        LIMIT 5
      `);

      // 3. Top artists in guild
      const topArtistsRes = await this.db.execute<{
        artist: string;
        play_count: number;
        total_listening_time: number;
      }>(sql`
        SELECT
          t.artist,
          COUNT(*)::int AS play_count,
          COALESCE(SUM(pe.duration_listened), 0)::int AS total_listening_time
        FROM playback_events pe
        JOIN tracks t ON pe.track_id = t.id
        WHERE pe.guild_id = ${guildId} AND t.artist IS NOT NULL AND t.artist != ''
        GROUP BY t.artist
        ORDER BY play_count DESC, total_listening_time DESC
        LIMIT 5
      `);

      return {
        guildId,
        totalTracksPlayed: totalPlays,
        totalListeningTime: Number(overall.total_listening_time),
        completionRate: Math.round(completionRate * 1000) / 1000,
        skipRate: Math.round(skipRate * 1000) / 1000,
        uniqueUsers: Number(overall.unique_users),
        uniqueTracks: Number(overall.unique_tracks),
        topTracks: topTracksRes.rows.map((r) => ({
          trackId: r.track_id,
          title: r.title,
          artist: r.artist,
          playCount: Number(r.play_count),
          totalListeningTime: Number(r.total_listening_time),
        })),
        topArtists: topArtistsRes.rows.map((r) => ({
          artist: r.artist,
          playCount: Number(r.play_count),
          totalListeningTime: Number(r.total_listening_time),
        })),
      };
    } catch (err) {
      this.logger.error({ err, guildId }, 'Failed to compute guild analytics');
      return {
        guildId,
        totalTracksPlayed: 0,
        totalListeningTime: 0,
        completionRate: 0,
        skipRate: 0,
        uniqueUsers: 0,
        uniqueTracks: 0,
        topTracks: [],
        topArtists: [],
      };
    }
  }

  /**
   * Clean old playback events beyond retention threshold.
   */
  async cleanOldHistory(retentionDays: number = 365): Promise<number> {
    if (!this.db || retentionDays <= 0) return 0;

    try {
      const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
      const res = await this.db.delete(schema.playbackEvents).where(lt(schema.playbackEvents.startedAt, cutoff));
      this.logger.info({ retentionDays, cutoff }, '[ANALYTICS] Cleaned old playback events');
      return (res as any)?.rowCount ?? 0;
    } catch (err) {
      this.logger.error({ err, retentionDays }, 'Failed to clean old history');
      return 0;
    }
  }
}
