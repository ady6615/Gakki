import * as fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createLogger } from '@gakki/core';
import { validateExternalUrl } from '../security/url-validator';
import { AudioCache, globalAudioCache } from './audio-cache';

const logger = createLogger('remote-stream');

export interface RemoteStreamOptions {
  timeoutMs?: number; // Connection timeout, default 10,000ms
  maxRetries?: number; // default 2 retries
  cache?: AudioCache;
}

export interface PreparedStreamResult {
  filePathOrUrl: string;
  isLocalFile: boolean;
  contentLength?: number;
  contentType?: string;
  cacheKey?: string;
}

/**
 * Handles remote audio streams with connection timeouts, retry policy,
 * SSRF validation, stream verification, and cache integration.
 */
export class RemoteStreamManager {
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly cache: AudioCache;

  // Active abort controllers per guild: guildId -> AbortController
  private readonly activeAbortControllers = new Map<string, AbortController>();

  constructor(options: RemoteStreamOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.cache = options.cache ?? globalAudioCache;
  }

  /**
   * Validate and prepare a remote audio stream for FFmpeg/Discord playback.
   *
   * @param guildId - Guild initiating playback
   * @param url - Remote audio stream or file URL
   * @param options - Ephemeral or persistent caching preferences
   */
  async prepareStream(
    guildId: string,
    url: string,
    options: { persistent?: boolean } = {},
  ): Promise<PreparedStreamResult> {
    // 1. SSRF & URL validation
    const parsedUrl = validateExternalUrl(url);

    // Cancel any previous pending remote stream fetch for this guild
    this.abortGuildStream(guildId);

    const controller = new AbortController();
    this.activeAbortControllers.set(guildId, controller);

    const cacheKey = this.cache.hashKey(url);

    // 2. Check cache first
    const cached = this.cache.get(cacheKey);
    if (cached && fs.existsSync(cached.filePath)) {
      logger.info({ guildId, url, filePath: cached.filePath }, '[STREAM] Ready (from cache)');
      this.activeAbortControllers.delete(guildId);
      return {
        filePathOrUrl: cached.filePath,
        isLocalFile: true,
        cacheKey,
      };
    }

    // 3. Fetch remote stream with retries and timeout
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt++) {
      if (controller.signal.aborted) {
        throw new Error('Remote stream preparation aborted');
      }

      try {
        logger.info(
          { guildId, url: parsedUrl.toString(), attempt, maxRetries: this.maxRetries },
          '[STREAM] Connected: connecting to %s (attempt %d)',
          parsedUrl.host,
          attempt,
        );

        const timeout = setTimeout(() => {
          controller.abort(new Error(`Connection timeout after ${this.timeoutMs}ms`));
        }, this.timeoutMs);

        const resp = await fetch(parsedUrl.toString(), {
          signal: controller.signal,
          headers: {
            'User-Agent': 'GakkiMusicPlatform/1.0',
            Accept: '*/*',
            'Icy-MetaData': '1',
          },
        });
        clearTimeout(timeout);

        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
        }

        const contentType = resp.headers.get('content-type') || '';
        const contentLength = resp.headers.get('content-length')
          ? parseInt(resp.headers.get('content-length')!, 10)
          : undefined;

        logger.info(
          { guildId, contentType, contentLength },
          '[STREAM] Buffering: stream received, buffering audio payload',
        );

        // If body is empty
        if (!resp.body) {
          throw new Error('Remote audio stream body is null');
        }

        // Buffer into AudioCache
        const entry = await this.cache.getOrFetch(
          cacheKey,
          async (targetPath) => {
            const outStream = fs.createWriteStream(targetPath);
            // @ts-expect-error Node fetch stream pipeline compatibility
            await pipeline(resp.body, outStream);
            const stat = await fs.promises.stat(targetPath);
            if (stat.size === 0) {
              throw new Error('Downloaded audio stream was 0 bytes');
            }
            return { sizeBytes: stat.size };
          },
          { persistent: options.persistent ?? false },
        );

        logger.info(
          { guildId, filePath: entry.filePath, bytes: entry.sizeBytes },
          '[STREAM] Ready: audio buffer completed and ready for playback',
        );

        this.activeAbortControllers.delete(guildId);
        return {
          filePathOrUrl: entry.filePath,
          isLocalFile: true,
          contentLength,
          contentType,
          cacheKey,
        };
      } catch (err: any) {
        lastError = err;
        logger.warn(
          { guildId, url, attempt, err: err?.message },
          '[STREAM] Failed attempt %d: %s',
          attempt,
          err?.message,
        );

        if (attempt <= this.maxRetries && !controller.signal.aborted) {
          // Wait briefly before retry
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }
    }

    this.activeAbortControllers.delete(guildId);
    logger.error({ guildId, url, lastError }, '[STREAM] Failed: all connection attempts exhausted');
    throw lastError || new Error('Remote stream preparation failed');
  }

  /**
   * Abort in-flight streaming / download operations for a guild.
   */
  abortGuildStream(guildId: string): void {
    const controller = this.activeAbortControllers.get(guildId);
    if (controller) {
      controller.abort();
      this.activeAbortControllers.delete(guildId);
      logger.debug({ guildId }, 'Aborted remote stream fetch for guild');
    }
  }

  /**
   * Clean up ephemeral stream cache on track finish or skip.
   */
  cleanupStream(cacheKey?: string): void {
    if (cacheKey) {
      this.cache.cleanupEphemeral(cacheKey);
    }
  }
}

export const globalRemoteStreamManager = new RemoteStreamManager();
