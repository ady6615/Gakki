import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { createLogger } from '@gakki/core';
import { validateExternalUrl } from '../security/url-validator';
import { getFfmpegPath } from '../audio/ffmpeg';

const logger = createLogger('artwork-service');

export interface ArtworkServiceOptions {
  storageDir?: string;
  maxSizeBytes?: number; // default 5MB per image
  maxTotalCacheMb?: number; // default 100MB
}

/**
 * Dedicated artwork service for resolving, normalizing, and caching
 * track album art safely.
 */
export class ArtworkService {
  private readonly storageDir: string;
  private readonly maxSizeBytes: number;
  private readonly maxTotalCacheMb: number;

  constructor(options: ArtworkServiceOptions = {}) {
    this.storageDir = options.storageDir ?? path.resolve(process.cwd(), 'storage/cache/artwork');
    this.maxSizeBytes = options.maxSizeBytes ?? 5 * 1024 * 1024; // 5 MB
    this.maxTotalCacheMb = options.maxTotalCacheMb ?? 100; // 100 MB

    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  /**
   * Get hash for a URL or track ID.
   */
  private getHash(input: string): string {
    return crypto.createHash('sha256').update(input).digest('hex').substring(0, 16);
  }

  /**
   * Resolve and cache remote image artwork.
   */
  async cacheArtworkFromUrl(url: string, trackId?: string): Promise<string | null> {
    try {
      validateExternalUrl(url);
    } catch (err) {
      logger.warn({ err, url }, 'Invalid artwork URL — skipping cache');
      return null;
    }

    const hash = this.getHash(url);
    const targetFile = path.join(this.storageDir, `${hash}.jpg`);

    // Return existing cached file if already downloaded
    if (fs.existsSync(targetFile)) {
      return `/api/artwork/${hash}.jpg`;
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);

      const resp = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'GakkiMusicBot/1.0' },
      });
      clearTimeout(timer);

      if (!resp.ok) {
        logger.warn({ status: resp.status, url }, 'Remote artwork fetch returned non-200');
        return null;
      }

      const contentType = resp.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) {
        logger.warn({ contentType, url }, 'Remote artwork URL is not an image');
        return null;
      }

      const buffer = Buffer.from(await resp.arrayBuffer());
      if (buffer.length > this.maxSizeBytes) {
        logger.warn({ size: buffer.length, max: this.maxSizeBytes, url }, 'Artwork image exceeds maximum size limit');
        return null;
      }

      await fs.promises.writeFile(targetFile, buffer);

      logger.info(
        { trackId, url, targetFile, bytes: buffer.length },
        '[ARTWORK] Cached: %s (%d bytes)',
        hash,
        buffer.length,
      );

      this.enforceCacheLimit();
      return `/api/artwork/${hash}.jpg`;
    } catch (err) {
      logger.warn({ err, url }, 'Failed to fetch and cache remote artwork');
      return null;
    }
  }

  /**
   * Extract embedded album art from a local audio file using FFmpeg.
   */
  async extractEmbeddedArtwork(audioFilePath: string, trackId?: string): Promise<string | null> {
    const hash = this.getHash(audioFilePath);
    const targetFile = path.join(this.storageDir, `${hash}.jpg`);

    if (fs.existsSync(targetFile)) {
      return `/api/artwork/${hash}.jpg`;
    }

    const ffmpegExe = getFfmpegPath();

    return new Promise((resolve) => {
      // ffmpeg -i <audio> -an -vcodec copy <target.jpg> -y
      execFile(
        ffmpegExe,
        ['-i', audioFilePath, '-an', '-vcodec', 'copy', '-y', targetFile],
        (err) => {
          if (err || !fs.existsSync(targetFile)) {
            resolve(null);
            return;
          }

          try {
            const stat = fs.statSync(targetFile);
            if (stat.size > 0 && stat.size <= this.maxSizeBytes) {
              logger.info(
                { trackId, audioFilePath, bytes: stat.size },
                '[ARTWORK] Cached: embedded artwork extracted for %s',
                path.basename(audioFilePath),
              );
              this.enforceCacheLimit();
              resolve(`/api/artwork/${hash}.jpg`);
            } else {
              if (fs.existsSync(targetFile)) fs.unlinkSync(targetFile);
              resolve(null);
            }
          } catch {
            resolve(null);
          }
        },
      );
    });
  }

  /**
   * Ensure cache directory does not exceed maximum configured disk storage.
   */
  private enforceCacheLimit(): void {
    try {
      const files = fs.readdirSync(this.storageDir);
      let totalBytes = 0;
      const fileStats: Array<{ file: string; size: number; mtime: number }> = [];

      for (const file of files) {
        const full = path.join(this.storageDir, file);
        const stat = fs.statSync(full);
        totalBytes += stat.size;
        fileStats.push({ file: full, size: stat.size, mtime: stat.mtimeMs });
      }

      const limitBytes = this.maxTotalCacheMb * 1024 * 1024;
      if (totalBytes > limitBytes) {
        // Sort oldest first
        fileStats.sort((a, b) => a.mtime - b.mtime);
        while (totalBytes > limitBytes && fileStats.length > 0) {
          const oldest = fileStats.shift()!;
          try {
            fs.unlinkSync(oldest.file);
            totalBytes -= oldest.size;
          } catch {
            // Ignore unlink errors
          }
        }
      }
    } catch (err) {
      logger.debug({ err }, 'Error checking artwork cache size');
    }
  }

  /**
   * Get physical filesystem path for a cached artwork hash.
   */
  getFilePath(hashWithExt: string): string | null {
    const safeName = path.basename(hashWithExt);
    const full = path.join(this.storageDir, safeName);
    return fs.existsSync(full) ? full : null;
  }
}
