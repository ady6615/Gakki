import { eq } from 'drizzle-orm';
import type { DatabaseClient } from '../database/connection';
import * as schema from '../database/schema';
import type { GuildSettings, AudioFilterConfig, LoopMode } from '../types/queue';
import { createLogger } from '../utils/logger';

const logger = createLogger('guild-settings');

export interface GuildSettingsManagerOptions {
  defaultIdleTimeoutSeconds?: number;
}

/**
 * Manages persistent guild settings backed by PostgreSQL.
 *
 * Persists:
 * - Volume (0 - 200)
 * - Audio filters (bassboost, speed, nightcore)
 * - Loop mode (off, track, queue)
 * - Stay in channel mode (boolean)
 * - Voice idle timeout (seconds)
 */
export class GuildSettingsManager {
  private readonly defaultTimeout: number;

  constructor(
    private readonly db: DatabaseClient | null = null,
    options: GuildSettingsManagerOptions = {},
  ) {
    this.defaultTimeout = options.defaultIdleTimeoutSeconds ?? 300;
  }

  /**
   * Default settings for a new or unconfigured guild.
   */
  getDefaults(guildId: string): GuildSettings {
    return {
      guildId,
      volume: 100,
      filters: {
        bassboost: false,
        speed: 1.0,
        nightcore: false,
      },
      loopMode: 'off',
      stayInChannel: false,
      voiceIdleTimeout: this.defaultTimeout,
    };
  }

  /**
   * Load settings for a specific guild from PostgreSQL.
   * If no record exists, returns the default settings.
   */
  async getSettings(guildId: string): Promise<GuildSettings> {
    if (!this.db) {
      return this.getDefaults(guildId);
    }

    try {
      const rows = await this.db
        .select()
        .from(schema.guildSettings)
        .where(eq(schema.guildSettings.guildId, guildId))
        .limit(1);

      if (rows.length === 0) {
        return this.getDefaults(guildId);
      }

      const row = rows[0];
      const settings: GuildSettings = {
        guildId: row.guildId,
        volume: row.volume,
        filters: {
          bassboost: row.bassboost,
          speed: row.speed,
          nightcore: row.nightcore,
        },
        loopMode: (row.loopMode as LoopMode) || 'off',
        stayInChannel: row.stayInChannel,
        voiceIdleTimeout: row.voiceIdleTimeout,
      };

      logger.info({ guildId }, '[DB] Guild settings loaded');
      return settings;
    } catch (err) {
      logger.error({ err, guildId }, 'Failed to query guild settings from database — falling back to defaults');
      return this.getDefaults(guildId);
    }
  }

  /**
   * Persist guild settings into PostgreSQL (upsert).
   */
  async saveSettings(settings: GuildSettings): Promise<void> {
    if (!this.db) {
      return;
    }

    try {
      await this.db
        .insert(schema.guildSettings)
        .values({
          guildId: settings.guildId,
          volume: settings.volume,
          bassboost: settings.filters.bassboost,
          speed: settings.filters.speed,
          nightcore: settings.filters.nightcore,
          loopMode: settings.loopMode,
          stayInChannel: settings.stayInChannel,
          voiceIdleTimeout: settings.voiceIdleTimeout,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: schema.guildSettings.guildId,
          set: {
            volume: settings.volume,
            bassboost: settings.filters.bassboost,
            speed: settings.filters.speed,
            nightcore: settings.filters.nightcore,
            loopMode: settings.loopMode,
            stayInChannel: settings.stayInChannel,
            voiceIdleTimeout: settings.voiceIdleTimeout,
            updatedAt: new Date(),
          },
        });

      logger.info(
        {
          guildId: settings.guildId,
          volume: settings.volume,
          filters: settings.filters,
          loopMode: settings.loopMode,
          stayInChannel: settings.stayInChannel,
        },
        '[DB] Guild settings updated',
      );
    } catch (err) {
      logger.error({ err, guildId: settings.guildId }, 'Failed to persist guild settings to database');
    }
  }

  /**
   * Load all guild settings on startup.
   */
  async loadAllSettings(): Promise<Map<string, GuildSettings>> {
    const map = new Map<string, GuildSettings>();
    if (!this.db) return map;

    try {
      const rows = await this.db.select().from(schema.guildSettings);
      for (const row of rows) {
        map.set(row.guildId, {
          guildId: row.guildId,
          volume: row.volume,
          filters: {
            bassboost: row.bassboost,
            speed: row.speed,
            nightcore: row.nightcore,
          },
          loopMode: (row.loopMode as LoopMode) || 'off',
          stayInChannel: row.stayInChannel,
          voiceIdleTimeout: row.voiceIdleTimeout,
        });
        logger.info({ guildId: row.guildId }, '[DB] Guild settings loaded');
      }
    } catch (err) {
      logger.error({ err }, 'Failed to bulk load guild settings from database');
    }

    return map;
  }
}
