import { createLogger } from '@gakki/core';

const logger = createLogger('rate-limiter');

export interface RateLimitOptions {
  windowMs: number; // e.g. 60,000 (1 minute)
  maxRequests: number; // e.g. 10
}

interface RateLimitRecord {
  timestamps: number[];
}

/**
 * Sliding window rate limiter for user and guild requests.
 */
export class RateLimiter {
  private readonly records = new Map<string, RateLimitRecord>();

  constructor(
    private readonly defaultUserLimit: RateLimitOptions = { windowMs: 60_000, maxRequests: 15 },
    private readonly defaultGuildLimit: RateLimitOptions = { windowMs: 60_000, maxRequests: 45 },
  ) {}

  /**
   * Check whether an action for a key is allowed under rate limits.
   *
   * @param key - Identifier e.g. `user:12345` or `guild:67890`
   * @param options - Custom limit or default
   */
  check(
    key: string,
    options?: RateLimitOptions,
  ): { allowed: boolean; remaining: number; retryAfterMs: number } {
    const opts = options ?? (key.startsWith('guild:') ? this.defaultGuildLimit : this.defaultUserLimit);
    const now = Date.now();
    const windowStart = now - opts.windowMs;

    let record = this.records.get(key);
    if (!record) {
      record = { timestamps: [] };
      this.records.set(key, record);
    }

    // Filter out timestamps outside window
    record.timestamps = record.timestamps.filter((t) => t > windowStart);

    if (record.timestamps.length >= opts.maxRequests) {
      const oldest = record.timestamps[0];
      const retryAfterMs = Math.max(0, oldest + opts.windowMs - now);
      logger.warn({ key, retryAfterMs }, '[SECURITY] Rate limit exceeded');
      return { allowed: false, remaining: 0, retryAfterMs };
    }

    record.timestamps.push(now);
    const remaining = opts.maxRequests - record.timestamps.length;
    return { allowed: true, remaining, retryAfterMs: 0 };
  }

  /**
   * Reset limits for a key or clear all records.
   */
  reset(key?: string): void {
    if (key) {
      this.records.delete(key);
    } else {
      this.records.clear();
    }
  }
}

export const globalRateLimiter = new RateLimiter();
