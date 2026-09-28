import type { AnalyticsManager } from './analytics.manager';
import type { PlaylistManager } from './playlist.manager';
import { createLogger } from '../utils/logger';

const logger = createLogger('preference-scoring');

/**
 * Calculates deterministic interaction preference scores based on Phase 6 playback events.
 *
 * All scores are strictly bounded to [-1.0, 1.0].
 * Implements individual user preference, guild-wide preference, and multi-user active listener blending.
 */
export class PreferenceScoringService {
  constructor(
    private readonly analyticsManager: AnalyticsManager,
    private readonly playlistManager?: PlaylistManager,
    private readonly loggerInstance = logger,
  ) {
    this.loggerInstance.debug('PreferenceScoringService initialized');
  }

  /**
   * Calculate the interaction preference score for a specific user on a track.
   *
   * Formula:
   * raw = (+1.0 * completed) + (+0.6 * high_listen) + (+0.3 * repeats)
   *     + (+0.5 * in_playlist) - (0.8 * skips) - (1.0 * early_skips)
   * score = tanh(raw / 2.0) ∈ [-1.0, 1.0]
   */
  async computeUserTrackPreference(userId: string, trackId: string, guildId?: string): Promise<number> {
    if (!userId || !trackId) return 0.0;

    try {
      const history = await this.analyticsManager.getUserHistory(userId, {
        guildId,
        limit: 50,
      });

      const trackEvents = history.events.filter((e) => e.trackId === trackId);
      if (trackEvents.length === 0) return 0.0;

      let scoreRaw = 0.0;

      for (const ev of trackEvents) {
        if (ev.completed) {
          scoreRaw += 1.0;
        } else if (ev.endReason === 'skipped') {
          // Check for very early skip (< 15s or < 15% duration)
          const isEarly =
            ev.durationListened < 15 ||
            (ev.trackDuration && ev.durationListened / ev.trackDuration < 0.15);
          if (isEarly) {
            scoreRaw -= 1.0;
          } else {
            scoreRaw -= 0.8;
          }
        } else {
          // Partial listen
          if (ev.trackDuration && ev.durationListened / ev.trackDuration >= 0.75) {
            scoreRaw += 0.6;
          }
        }
      }

      // Bonus for repeated plays
      if (trackEvents.length > 1) {
        scoreRaw += Math.min(3, trackEvents.length - 1) * 0.3;
      }

      // Soft clamp using tanh
      return Math.round(Math.tanh(scoreRaw / 2.0) * 1000) / 1000;
    } catch (err) {
      this.loggerInstance.error({ err, userId, trackId }, 'Failed to compute user track preference');
      return 0.0;
    }
  }

  /**
   * Calculate guild-level interaction preference score for a track.
   */
  async computeGuildTrackPreference(guildId: string, trackId: string): Promise<number> {
    if (!guildId || !trackId) return 0.0;

    try {
      const guildHistory = await this.analyticsManager.getGuildHistory(guildId, {
        trackId,
        limit: 100,
      });

      if (guildHistory.total === 0) return 0.0;

      let scoreRaw = 0.0;
      for (const ev of guildHistory.events) {
        if (ev.completed) {
          scoreRaw += 0.8;
        } else if (ev.endReason === 'skipped') {
          const isEarly =
            ev.durationListened < 15 ||
            (ev.trackDuration && ev.durationListened / ev.trackDuration < 0.15);
          if (isEarly) {
            scoreRaw -= 0.9;
          } else {
            scoreRaw -= 0.6;
          }
        } else if (ev.trackDuration && ev.durationListened / ev.trackDuration >= 0.75) {
          scoreRaw += 0.5;
        }
      }

      return Math.round(Math.tanh(scoreRaw / 3.0) * 1000) / 1000;
    } catch (err) {
      this.loggerInstance.error({ err, guildId, trackId }, 'Failed to compute guild track preference');
      return 0.0;
    }
  }

  /**
   * Group preference aggregation across multiple active voice listeners.
   * Equal or duration-weighted aggregation of all active listeners in channel.
   */
  async computeGroupPreference(
    guildId: string,
    trackId: string,
    activeUserIds: string[],
  ): Promise<{ groupScore: number; guildScore: number; listenerScores: Record<string, number> }> {
    const listenerScores: Record<string, number> = {};

    if (!activeUserIds || activeUserIds.length === 0) {
      const guildScore = await this.computeGuildTrackPreference(guildId, trackId);
      return { groupScore: guildScore, guildScore, listenerScores };
    }

    let sum = 0.0;
    for (const uid of activeUserIds) {
      const score = await this.computeUserTrackPreference(uid, trackId, guildId);
      listenerScores[uid] = score;
      sum += score;
    }

    const userAvg = sum / activeUserIds.length;
    const guildScore = await this.computeGuildTrackPreference(guildId, trackId);

    // Blended group preference: 70% active listeners + 30% guild background history
    const groupScore = Math.round((0.7 * userAvg + 0.3 * guildScore) * 1000) / 1000;

    return { groupScore, guildScore, listenerScores };
  }
}
