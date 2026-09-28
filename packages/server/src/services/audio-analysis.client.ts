import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import type { AudioFeatureManager, AcousticFeatures, AnalysisStatus } from '@gakki/core';
import { createLogger } from '@gakki/core';
import { broadcastEvent } from '../websocket';

const logger = createLogger('audio-analysis-client');

export interface AnalysisJob {
  trackId: string;
  filePath: string;
  guildId?: string;
  contentHash?: string;
}

/**
 * Client for the Python Audio Analysis Service.
 *
 * Implements:
 * 1. HTTP communication with Flask analyzer server (primary)
 * 2. Direct Python subprocess execution (fallback if HTTP service is offline)
 * 3. Bounded concurrency queue (max 2 active jobs)
 * 4. Content hash deduplication & caching
 * 5. Asynchronous non-blocking background execution
 * 6. WebSocket event broadcasting
 */
export class AudioAnalysisClient {
  private readonly serviceUrl: string;
  private readonly maxConcurrency: number;
  private readonly jobTimeoutMs: number;
  private activeJobsCount = 0;
  private readonly jobQueue: AnalysisJob[] = [];
  private readonly processingTrackIds = new Set<string>();

  constructor(
    private readonly featureManager: AudioFeatureManager,
    options: {
      serviceUrl?: string;
      maxConcurrency?: number;
      jobTimeoutMs?: number;
    } = {},
  ) {
    this.serviceUrl = options.serviceUrl || process.env.AUDIO_ANALYZER_URL || 'http://127.0.0.1:5050';
    this.maxConcurrency = options.maxConcurrency || 2;
    this.jobTimeoutMs = options.jobTimeoutMs || 30000;

    logger.info(
      { serviceUrl: this.serviceUrl, maxConcurrency: this.maxConcurrency },
      'AudioAnalysisClient initialized',
    );
  }

  /**
   * Queue a track for background audio feature analysis.
   * NEVER blocks playback.
   */
  queueAnalysis(job: AnalysisJob): void {
    if (this.processingTrackIds.has(job.trackId)) {
      logger.debug({ trackId: job.trackId }, 'Track is already being analyzed or queued');
      return;
    }

    if (!fs.existsSync(job.filePath)) {
      logger.warn({ filePath: job.filePath }, 'Cannot analyze audio: file does not exist');
      return;
    }

    this.processingTrackIds.add(job.trackId);
    this.jobQueue.push(job);
    logger.debug({ trackId: job.trackId, queueLength: this.jobQueue.length }, 'Queued audio analysis job');

    // Trigger process loop asynchronously
    setImmediate(() => this.processNextJob());
  }

  /**
   * Process the next job in the bounded concurrency queue.
   */
  private async processNextJob(): Promise<void> {
    if (this.activeJobsCount >= this.maxConcurrency || this.jobQueue.length === 0) {
      return;
    }

    const job = this.jobQueue.shift();
    if (!job) return;

    this.activeJobsCount++;

    try {
      await this.executeJob(job);
    } catch (err) {
      logger.error({ err, trackId: job.trackId }, 'Unhandled error during audio analysis execution');
    } finally {
      this.activeJobsCount--;
      this.processingTrackIds.delete(job.trackId);
      setImmediate(() => this.processNextJob());
    }
  }

  /**
   * Execute an individual audio analysis job.
   */
  private async executeJob(job: AnalysisJob): Promise<void> {
    const { trackId, filePath, guildId } = job;

    // 1. Content Hash Verification & Cache Check
    let contentHash = job.contentHash;
    if (!contentHash) {
      try {
        contentHash = await this.computeFileHash(filePath);
      } catch {
        contentHash = undefined;
      }
    }

    if (contentHash) {
      const cached = await this.featureManager.findByContentHash(contentHash);
      if (cached && cached.analysisStatus === 'READY') {
        logger.info({ trackId, contentHash }, '[ANALYZER] Reusing existing cached audio features');
        await this.featureManager.saveFeatures({
          ...cached,
          trackId,
        });

        broadcastEvent({
          type: 'analysis.completed',
          trackId,
          guildId,
          cached: true,
          bpm: cached.bpm,
          energy: cached.energy,
        });
        return;
      }
    }

    // Mark status as PROCESSING
    await this.featureManager.setStatus(trackId, 'PROCESSING');
    broadcastEvent({
      type: 'analysis.started',
      trackId,
      guildId,
    });

    // 2. Attempt HTTP Analysis via Python Service
    let result = await this.analyzeViaHttp(filePath, contentHash);

    // 3. Subprocess Fallback if HTTP service is unavailable
    if (!result) {
      logger.info({ trackId }, '[ANALYZER] HTTP service unavailable, executing Python worker fallback');
      result = await this.analyzeViaSubprocess(filePath, contentHash);
    }

    // 4. Handle Result
    if (!result || result.analysisStatus === 'FAILED') {
      const errorMsg = result?.errorMessage || 'Analysis failed or analyzer offline';
      logger.warn({ trackId, errorMsg }, '[ANALYZER] Audio analysis failed');
      await this.featureManager.setStatus(trackId, 'FAILED', errorMsg);

      broadcastEvent({
        type: 'analysis.failed',
        trackId,
        guildId,
        error: errorMsg,
      });
      return;
    }

    // 5. Persist Extracted Acoustic Features
    const saved = await this.featureManager.saveFeatures({
      ...result,
      trackId,
      analysisStatus: 'READY',
      contentHash: contentHash || result.contentHash,
    });

    logger.info(
      { trackId, bpm: saved.bpm, energy: saved.energy, key: saved.key },
      '[ANALYZER] Audio analysis completed successfully',
    );

    broadcastEvent({
      type: 'analysis.completed',
      trackId,
      guildId,
      cached: false,
      bpm: saved.bpm,
      energy: saved.energy,
      key: saved.key,
    });
  }

  /**
   * Send HTTP POST request to Python analyzer service.
   */
  private async analyzeViaHttp(filePath: string, contentHash?: string): Promise<AcousticFeatures | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.jobTimeoutMs);

    try {
      const response = await fetch(`${this.serviceUrl}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath, contentHash }),
        signal: controller.signal,
      });

      if (!response.ok) {
        logger.warn({ status: response.status }, 'HTTP audio analyzer returned non-200 response');
        return null;
      }

      const data = (await response.json()) as any;
      return data;
    } catch {
      // Service offline or connection refused — return null to trigger fallback
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Subprocess fallback: executes python analyzer.py directly.
   */
  private async analyzeViaSubprocess(filePath: string, contentHash?: string): Promise<AcousticFeatures | null> {
    return new Promise((resolve) => {
      const analyzerScript = path.resolve(
        process.cwd(),
        'services',
        'audio-analyzer',
        'analyzer.py',
      );

      if (!fs.existsSync(analyzerScript)) {
        logger.error({ analyzerScript }, 'Subprocess analyzer script not found');
        return resolve(null);
      }

      const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
      const args = [analyzerScript, filePath];
      if (contentHash) args.push(contentHash);

      const proc = spawn(pythonCmd, args, {
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';

      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        logger.warn({ filePath }, 'Subprocess audio analysis timed out');
        resolve(null);
      }, this.jobTimeoutMs);

      proc.stdout.on('data', (d) => {
        stdout += d.toString();
      });

      proc.stderr.on('data', (d) => {
        stderr += d.toString();
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          logger.warn({ code, stderr }, 'Subprocess audio analysis exited with non-zero code');
          try {
            const parsed = JSON.parse(stdout);
            return resolve(parsed);
          } catch {
            return resolve(null);
          }
        }

        try {
          // Find JSON in stdout (in case librosa printed info lines)
          const jsonStart = stdout.indexOf('{');
          const jsonEnd = stdout.lastIndexOf('}');
          if (jsonStart !== -1 && jsonEnd !== -1) {
            const jsonStr = stdout.substring(jsonStart, jsonEnd + 1);
            const parsed = JSON.parse(jsonStr);
            return resolve(parsed);
          }
          return resolve(null);
        } catch (err) {
          logger.error({ err, stdout }, 'Failed to parse JSON from subprocess audio analysis');
          resolve(null);
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        logger.error({ err }, 'Failed to spawn Python analyzer subprocess');
        resolve(null);
      });
    });
  }

  /**
   * Compute SHA-256 hash of audio file.
   */
  private computeFileHash(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', (err) => reject(err));
    });
  }
}
