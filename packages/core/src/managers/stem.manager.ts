/**
 * Phase 9: Stem Manager & Storage Lifecycle
 *
 * Implements requirements 7, 8, 9, 29, 37, 38:
 * - Content-hash based stem caching: trackHash:modelName:modelVersion
 * - Configurable storage modes: persistent, temporary, disabled
 * - Storage workspace: storage/tmp/stems/, storage/stems/, storage/tmp/transitions/
 * - Database persistence (track_stems and track_vocal_features)
 * - Startup orphan cleanup and TTL management
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { eq, and } from 'drizzle-orm';
import type { DatabaseClient } from '../database/connection';
import * as schema from '../database/schema';
import type {
  CanonicalStemSet,
  StemQualityScore,
  StemSeparationResult,
  StemStorageMode,
  TrackVocalFeatures,
} from '../types/stem';
import { createLogger } from '../utils/logger';

const logger = createLogger('stem-manager');

export interface StemManagerOptions {
  storageDir?: string;
  maxCacheGb?: number;
  tempTtlHours?: number;
}

export class StemManager {
  private static readonly sharedStems = new Map<string, StemSeparationResult>();
  private static readonly sharedVocalFeatures = new Map<string, TrackVocalFeatures>();

  private readonly storageRoot: string;
  private readonly persistentStemsDir: string;
  private readonly tempStemsDir: string;
  private readonly tempTransitionsDir: string;
  private readonly maxCacheBytes: number;
  private readonly tempTtlMs: number;

  constructor(
    private readonly db: DatabaseClient | null = null,
    options?: StemManagerOptions,
  ) {
    const root = options?.storageDir || process.env.STORAGE_DIR || path.join(process.cwd(), 'storage');
    this.storageRoot = path.resolve(root);
    this.persistentStemsDir = path.join(this.storageRoot, 'stems');
    this.tempStemsDir = path.join(this.storageRoot, 'tmp', 'stems');
    this.tempTransitionsDir = path.join(this.storageRoot, 'tmp', 'transitions');

    const maxGb = options?.maxCacheGb || Number(process.env.DJ_MAX_STEM_CACHE_GB || 20);
    this.maxCacheBytes = maxGb * 1024 * 1024 * 1024;
    const ttlHours = options?.tempTtlHours || Number(process.env.STEM_TEMP_TTL_HOURS || 24);
    this.tempTtlMs = ttlHours * 60 * 60 * 1000;

    this.ensureDirectories();
  }

  private ensureDirectories(): void {
    try {
      if (!fs.existsSync(this.persistentStemsDir)) {
        fs.mkdirSync(this.persistentStemsDir, { recursive: true });
      }
      if (!fs.existsSync(this.tempStemsDir)) {
        fs.mkdirSync(this.tempStemsDir, { recursive: true });
      }
      if (!fs.existsSync(this.tempTransitionsDir)) {
        fs.mkdirSync(this.tempTransitionsDir, { recursive: true });
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to create stem storage directories');
    }
  }

  public getDirectories() {
    return {
      storageRoot: this.storageRoot,
      persistentStemsDir: this.persistentStemsDir,
      tempStemsDir: this.tempStemsDir,
      tempTransitionsDir: this.tempTransitionsDir,
    };
  }

  public buildCacheKey(contentHash: string, modelName: string, modelVersion: string): string {
    return `${contentHash}:${modelName}:${modelVersion}`;
  }

  /**
   * Save stem separation results to DB or memory
   */
  public async saveStems(result: StemSeparationResult): Promise<StemSeparationResult> {
    StemManager.sharedStems.set(result.trackId, result);

    if (!this.db) {
      return result;
    }

    try {
      await this.db
        .insert(schema.trackStems)
        .values({
          trackId: result.trackId,
          provider: result.provider,
          modelName: result.modelName,
          modelVersion: result.modelVersion,
          analysisVersion: 1,
          vocalsPath: result.stems.vocals,
          drumsPath: result.stems.drums,
          bassPath: result.stems.bass,
          otherPath: result.stems.other,
          duration: result.duration,
          sampleRate: result.sampleRate,
          channels: result.channels,
          vocalConfidence: result.quality.vocalConfidence,
          qualityScore: result.quality.overallQuality,
          storageMode: result.storageMode,
          status: 'READY',
          errorMessage: null,
          createdAt: result.createdAt,
          expiresAt: result.expiresAt ?? null,
        })
        .onConflictDoUpdate({
          target: [
            schema.trackStems.trackId,
            schema.trackStems.provider,
            schema.trackStems.modelName,
            schema.trackStems.modelVersion,
          ],
          set: {
            vocalsPath: result.stems.vocals,
            drumsPath: result.stems.drums,
            bassPath: result.stems.bass,
            otherPath: result.stems.other,
            duration: result.duration,
            sampleRate: result.sampleRate,
            channels: result.channels,
            vocalConfidence: result.quality.vocalConfidence,
            qualityScore: result.quality.overallQuality,
            storageMode: result.storageMode,
            status: 'READY',
            expiresAt: result.expiresAt ?? null,
          },
        });
    } catch (err) {
      logger.error({ err, trackId: result.trackId }, 'Failed to persist track stems to database');
    }

    return result;
  }

  /**
   * Retrieve stems for a track from DB or memory
   */
  public async getStems(trackId: string, modelName?: string): Promise<StemSeparationResult | null> {
    const mem = StemManager.sharedStems.get(trackId);
    if (mem && (!modelName || mem.modelName === modelName)) {
      return mem;
    }

    if (!this.db) return null;

    try {
      const condition = modelName
        ? and(eq(schema.trackStems.trackId, trackId), eq(schema.trackStems.modelName, modelName))
        : eq(schema.trackStems.trackId, trackId);

      const rows = await this.db.select().from(schema.trackStems).where(condition).limit(1);
      if (rows.length === 0) return null;

      const r = rows[0];
      const result: StemSeparationResult = {
        id: r.id,
        trackId: r.trackId,
        provider: r.provider,
        modelName: r.modelName,
        modelVersion: r.modelVersion,
        stems: {
          vocals: r.vocalsPath,
          drums: r.drumsPath,
          bass: r.bassPath,
          other: r.otherPath,
        },
        duration: r.duration,
        sampleRate: r.sampleRate,
        channels: r.channels,
        quality: {
          vocalConfidence: r.vocalConfidence ?? 0.8,
          drumConfidence: 0.85,
          bassConfidence: 0.85,
          otherConfidence: 0.8,
          overallQuality: r.qualityScore ?? 0.85,
        },
        storageMode: r.storageMode as StemStorageMode,
        separationTimeMs: 0,
        cached: true,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
      };

      StemManager.sharedStems.set(trackId, result);
      return result;
    } catch (err) {
      logger.error({ err, trackId }, 'Failed to query track stems from database');
      return null;
    }
  }

  /**
   * Save vocal features to DB or memory
   */
  public async saveVocalFeatures(features: TrackVocalFeatures): Promise<TrackVocalFeatures> {
    StemManager.sharedVocalFeatures.set(features.trackId, features);

    if (!this.db) return features;

    try {
      await this.db
        .insert(schema.trackVocalFeatures)
        .values({
          trackId: features.trackId,
          featureVersion: features.featureVersion,
          meanVocalActivity: features.meanVocalActivity,
          vocalActivityEnvelope: JSON.stringify(features.vocalEnvelope),
          vocalStartSeconds: features.vocalCues.vocalStartSeconds,
          vocalEndSeconds: features.vocalCues.vocalEndSeconds,
          vocalIntensity: features.vocalCues.vocalIntensity,
          vocalConfidence: features.vocalCues.confidence,
          instrumentalOutroStart: features.instrumentalCues.outroStartSeconds,
          instrumentalOutroEnd: features.instrumentalCues.outroEndSeconds,
          instrumentalIntensity: features.instrumentalCues.instrumentalIntensity,
          analysisStatus: features.analysisStatus,
          errorMessage: features.errorMessage,
        })
        .onConflictDoUpdate({
          target: [schema.trackVocalFeatures.trackId],
          set: {
            featureVersion: features.featureVersion,
            meanVocalActivity: features.meanVocalActivity,
            vocalActivityEnvelope: JSON.stringify(features.vocalEnvelope),
            vocalStartSeconds: features.vocalCues.vocalStartSeconds,
            vocalEndSeconds: features.vocalCues.vocalEndSeconds,
            vocalIntensity: features.vocalCues.vocalIntensity,
            vocalConfidence: features.vocalCues.confidence,
            instrumentalOutroStart: features.instrumentalCues.outroStartSeconds,
            instrumentalOutroEnd: features.instrumentalCues.outroEndSeconds,
            instrumentalIntensity: features.instrumentalCues.instrumentalIntensity,
            analysisStatus: features.analysisStatus,
            errorMessage: features.errorMessage,
            updatedAt: new Date(),
          },
        });
    } catch (err) {
      logger.error({ err, trackId: features.trackId }, 'Failed to persist vocal features to database');
    }

    return features;
  }

  /**
   * Retrieve vocal features for a track
   */
  public async getVocalFeatures(trackId: string): Promise<TrackVocalFeatures | null> {
    const mem = StemManager.sharedVocalFeatures.get(trackId);
    if (mem) return mem;

    if (!this.db) return null;

    try {
      const rows = await this.db
        .select()
        .from(schema.trackVocalFeatures)
        .where(eq(schema.trackVocalFeatures.trackId, trackId))
        .limit(1);

      if (rows.length === 0) return null;

      const r = rows[0];
      const parsedEnvelope = r.vocalActivityEnvelope ? JSON.parse(r.vocalActivityEnvelope) : [];

      const features: TrackVocalFeatures = {
        trackId: r.trackId,
        featureVersion: r.featureVersion,
        meanVocalActivity: r.meanVocalActivity,
        vocalEnvelope: parsedEnvelope,
        vocalCues: {
          vocalStartSeconds: r.vocalStartSeconds,
          vocalEndSeconds: r.vocalEndSeconds,
          vocalIntensity: r.vocalIntensity ?? 0.0,
          confidence: r.vocalConfidence ?? 0.8,
        },
        instrumentalCues: {
          outroStartSeconds: r.instrumentalOutroStart,
          outroEndSeconds: r.instrumentalOutroEnd,
          instrumentalIntensity: r.instrumentalIntensity ?? 0.0,
          confidence: 0.8,
        },
        analysisStatus: (r.analysisStatus as any) || 'READY',
        errorMessage: r.errorMessage,
      };

      StemManager.sharedVocalFeatures.set(trackId, features);
      return features;
    } catch (err) {
      logger.error({ err, trackId }, 'Failed to query vocal features from database');
      return null;
    }
  }

  /**
   * Clean up orphaned temporary stems and old transition mixes on startup or cron
   */
  public async cleanOrphanedStems(customTtlMs?: number): Promise<{ cleanedCount: number; freedBytes: number }> {
    const ttl = customTtlMs ?? this.tempTtlMs;
    const now = Date.now();
    let cleanedCount = 0;
    let freedBytes = 0;

    const dirsToClean = [this.tempStemsDir, this.tempTransitionsDir];

    for (const dir of dirsToClean) {
      if (!fs.existsSync(dir)) continue;

      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          try {
            const stat = fs.statSync(fullPath);
            if (entry.isDirectory()) {
              // Check directory mtime
              if (now - stat.mtimeMs > ttl) {
                const size = this.getFolderSize(fullPath);
                fs.rmSync(fullPath, { recursive: true, force: true });
                cleanedCount++;
                freedBytes += size;
              }
            } else if (entry.isFile()) {
              if (now - stat.mtimeMs > ttl) {
                freedBytes += stat.size;
                fs.unlinkSync(fullPath);
                cleanedCount++;
              }
            }
          } catch {}
        }
      } catch (err) {
        logger.warn({ err, dir }, 'Error scanning temp directory for cleanup');
      }
    }

    logger.info({ cleanedCount, freedBytes }, 'Stem workspace orphan cleanup completed');
    return { cleanedCount, freedBytes };
  }

  private getFolderSize(dirPath: string): number {
    let size = 0;
    try {
      const files = fs.readdirSync(dirPath);
      for (const file of files) {
        const p = path.join(dirPath, file);
        const stat = fs.statSync(p);
        size += stat.isDirectory() ? this.getFolderSize(p) : stat.size;
      }
    } catch {}
    return size;
  }
}
