/**
 * Voice & AI Rate Limiter
 *
 * Implements Requirement 34:
 * Per-user, per-session, and per-guild rate limiting for:
 * - Gemini Live sessions
 * - Speech recognition & transcription requests
 * - TTS commentary generation
 * - Voice commands
 */

export interface RateLimitConfig {
  maxCommandsPerMinuteUser: number; // e.g. 20
  maxTtsPerMinuteGuild: number; // e.g. 10
  maxGeminiSessionsPerGuild: number; // e.g. 2
  windowMs: number; // 60,000 ms
}

export class VoiceRateLimiter {
  private readonly config: RateLimitConfig;
  private readonly userCommandTimestamps = new Map<string, number[]>(); // userId -> timestamps
  private readonly guildTtsTimestamps = new Map<string, number[]>(); // guildId -> timestamps
  private readonly guildActiveSessions = new Map<string, number>(); // guildId -> count

  constructor(config?: Partial<RateLimitConfig>) {
    this.config = {
      maxCommandsPerMinuteUser: 20,
      maxTtsPerMinuteGuild: 10,
      maxGeminiSessionsPerGuild: 2,
      windowMs: 60000,
      ...config,
    };
  }

  /**
   * Check if a voice command is allowed for a user.
   */
  canExecuteCommand(userId: string): { allowed: boolean; remaining: number; retryAfterMs?: number } {
    const now = Date.now();
    let timestamps = this.userCommandTimestamps.get(userId) || [];
    // Filter out timestamps outside sliding window
    timestamps = timestamps.filter((t) => now - t < this.config.windowMs);

    if (timestamps.length >= this.config.maxCommandsPerMinuteUser) {
      const oldest = timestamps[0];
      const retryAfterMs = this.config.windowMs - (now - oldest);
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs,
      };
    }

    timestamps.push(now);
    this.userCommandTimestamps.set(userId, timestamps);

    return {
      allowed: true,
      remaining: this.config.maxCommandsPerMinuteUser - timestamps.length,
    };
  }

  /**
   * Check if TTS generation is allowed for a guild.
   */
  canGenerateTTS(guildId: string): { allowed: boolean; remaining: number } {
    const now = Date.now();
    let timestamps = this.guildTtsTimestamps.get(guildId) || [];
    timestamps = timestamps.filter((t) => now - t < this.config.windowMs);

    if (timestamps.length >= this.config.maxTtsPerMinuteGuild) {
      return { allowed: false, remaining: 0 };
    }

    timestamps.push(now);
    this.guildTtsTimestamps.set(guildId, timestamps);

    return {
      allowed: true,
      remaining: this.config.maxTtsPerMinuteGuild - timestamps.length,
    };
  }

  /**
   * Acquire a Gemini Live session slot for a guild.
   */
  acquireSessionSlot(guildId: string): boolean {
    const current = this.guildActiveSessions.get(guildId) || 0;
    if (current >= this.config.maxGeminiSessionsPerGuild) {
      return false;
    }
    this.guildActiveSessions.set(guildId, current + 1);
    return true;
  }

  /**
   * Release a Gemini Live session slot.
   */
  releaseSessionSlot(guildId: string): void {
    const current = this.guildActiveSessions.get(guildId) || 0;
    if (current > 0) {
      this.guildActiveSessions.set(guildId, current - 1);
    }
  }

  reset(): void {
    this.userCommandTimestamps.clear();
    this.guildTtsTimestamps.clear();
    this.guildActiveSessions.clear();
  }
}
