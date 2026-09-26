import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { createLogger } from '@gakki/core';

const logger = createLogger('audio-cache');

export type CacheState = 'MISS' | 'DOWNLOADING' | 'READY' | 'EXPIRED' | 'FAILED';

export interface AudioCacheOptions {
  enabled?: boolean;
  storageDir?: string;
  maxSizeMb?: number; // default 500 MB
  ttlSeconds?: number; // default 86400 (24h)
}

export interface CacheEntry {
  key: string;
  filePath: string;
  state: CacheState;
  sizeBytes: number;
  createdAt: number;
  persistent: boolean;
}

/**
 * Audio Cache with bounded size, TTL eviction, in-flight download deduplication,
 * and ephemeral stream support.
 */
export class AudioCache {
  readonly enabled: boolean;
  private readonly storageDir: string;
  private readonly maxSizeMb: number;
  private readonly ttlSeconds: number;

  // In-flight download deduplication: key -> Promise<CacheEntry>
  private readonly pendingDownloads = new Map<string, Promise<CacheEntry>>();
  // Active entries tracking
  private readonly entries = new Map<string, CacheEntry>();

  constructor(options: AudioCacheOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.storageDir = options.storageDir ?? path.resolve(process.cwd(), 'storage/cache/audio');
    this.maxSizeMb = options.maxSizeMb ?? 500;
    this.ttlSeconds = options.ttlSeconds ?? 86400;

    if (this.enabled && !fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  /**
   * Generate safe hash key for a URL or identifier.
   */
  hashKey(input: string): string {
    return crypto.createHash('sha256').update(input).digest('hex').substring(0, 32);
  }

  /**
   * Get the expected local cache file path for a key.
   */
  getFilePathForKey(key: string, ext = '.audio'): string {
    return path.join(this.storageDir, `${key}${ext}`);
  }

  /**
   * Check if a valid, unexpired entry exists in the cache.
   */
  get(key: string): CacheEntry | null {
    if (!this.enabled) return null;

    const entry = this.entries.get(key);
    const targetFile = this.getFilePathForKey(key);

    if (entry && entry.state === 'READY') {
      const now = Date.now();
      const ageSeconds = (now - entry.createdAt) / 1000;
      if (ageSeconds > this.ttlSeconds) {
        logger.info({ key }, '[CACHE] Expired: %s', key);
        this.remove(key);
        return null;
      }
      logger.info({ key, filePath: entry.filePath }, '[CACHE] Hit: %s', key);
      return entry;
    }

    if (fs.existsSync(targetFile)) {
      const stat = fs.statSync(targetFile);
      const now = Date.now();
      const ageSeconds = (now - stat.mtimeMs) / 1000;
      if (ageSeconds > this.ttlSeconds) {
        logger.info({ key }, '[CACHE] Expired: %s', key);
        try {
          fs.unlinkSync(targetFile);
        } catch {}
        return null;
      }

      const recovered: CacheEntry = {
        key,
        filePath: targetFile,
        state: 'READY',
        sizeBytes: stat.size,
        createdAt: stat.mtimeMs,
        persistent: true,
      };
      this.entries.set(key, recovered);
      logger.info({ key, filePath: targetFile }, '[CACHE] Hit: %s', key);
      return recovered;
    }

    logger.debug({ key }, '[CACHE] Miss: %s', key);
    return null;
  }

  /**
   * Retrieve cached item or execute loader with deduplication.
   * If two requests for the same source arrive concurrently, only ONE download occurs.
   *
   * @param key - Cache key
   * @param loader - Function that performs download/buffering and writes to target file
   * @param options - Cache options including persistent flag
   */
  async getOrFetch(
    key: string,
    loader: (targetPath: string) => Promise<{ sizeBytes: number; extension?: string }>,
    options: { persistent?: boolean } = {},
  ): Promise<CacheEntry> {
    const persistent = options.persistent ?? true;

    // 1. Check existing cache
    const existing = this.get(key);
    if (existing) {
      return existing;
    }

    // 2. Check in-flight pending download (Deduplication)
    const pending = this.pendingDownloads.get(key);
    if (pending) {
      logger.debug({ key }, '[CACHE] Joining in-flight download for key: %s', key);
      return pending;
    }

    // 3. Initiate download
    const targetFile = this.getFilePathForKey(key);
    const downloadPromise = (async () => {
      logger.info({ key, persistent }, '[CACHE] Miss — buffering/downloading: %s', key);
      try {
        const result = await loader(targetFile);
        const entry: CacheEntry = {
          key,
          filePath: targetFile,
          state: 'READY',
          sizeBytes: result.sizeBytes,
          createdAt: Date.now(),
          persistent,
        };
        this.entries.set(key, entry);
        this.enforceSizeLimit();
        return entry;
      } catch (err) {
        logger.error({ err, key }, 'Audio cache fetch failed: %s', key);
        if (fs.existsSync(targetFile)) {
          try {
            fs.unlinkSync(targetFile);
          } catch {}
        }
        throw err;
      } finally {
        this.pendingDownloads.delete(key);
      }
    })();

    this.pendingDownloads.set(key, downloadPromise);
    return downloadPromise;
  }

  /**
   * Evict an entry by key.
   */
  remove(key: string): void {
    const entry = this.entries.get(key);
    const targetFile = entry?.filePath ?? this.getFilePathForKey(key);
    this.entries.delete(key);
    if (fs.existsSync(targetFile)) {
      try {
        fs.unlinkSync(targetFile);
      } catch (err) {
        logger.debug({ err, targetFile }, 'Could not unlink cache file');
      }
    }
  }

  /**
   * Clean up ephemeral (non-persistent) cache file after playback.
   */
  cleanupEphemeral(key: string): void {
    const entry = this.entries.get(key);
    if (entry && !entry.persistent) {
      logger.info({ key }, '[CACHE] Cleaning up ephemeral cache file for: %s', key);
      this.remove(key);
    }
  }

  /**
   * Enforce bounded cache size limit.
   */
  private enforceSizeLimit(): void {
    try {
      if (!fs.existsSync(this.storageDir)) return;
      const files = fs.readdirSync(this.storageDir);
      let totalBytes = 0;
      const statsList: Array<{ path: string; size: number; mtime: number }> = [];

      for (const file of files) {
        const full = path.join(this.storageDir, file);
        const stat = fs.statSync(full);
        totalBytes += stat.size;
        statsList.push({ path: full, size: stat.size, mtime: stat.mtimeMs });
      }

      const maxBytes = this.maxSizeMb * 1024 * 1024;
      if (totalBytes > maxBytes) {
        statsList.sort((a, b) => a.mtime - b.mtime); // Oldest first
        while (totalBytes > maxBytes && statsList.length > 0) {
          const oldest = statsList.shift()!;
          try {
            fs.unlinkSync(oldest.path);
            totalBytes -= oldest.size;
          } catch {}
        }
      }
    } catch (err) {
      logger.debug({ err }, 'Error enforcing audio cache limit');
    }
  }
}

export const globalAudioCache = new AudioCache();
