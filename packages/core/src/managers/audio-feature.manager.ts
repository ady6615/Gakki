import { eq, sql } from 'drizzle-orm';
import type { DatabaseClient } from '../database/connection';
import * as schema from '../database/schema';
import type {
  AcousticFeatures,
  AnalysisStatus,
} from '../types/recommendation';
import { createLogger } from '../utils/logger';

const logger = createLogger('audio-feature-manager');

export type TrackFeaturesRow = typeof schema.trackFeatures.$inferSelect;

/**
 * Manages storage and retrieval of track acoustic features and vector embeddings.
 *
 * Interfaces with PostgreSQL (pgvector) when available, and provides
 * seamless in-memory fallbacks when running without a database or during tests.
 */
export class AudioFeatureManager {
  // Process-wide shared memory store for tests / offline mode
  private static readonly sharedFeatures = new Map<string, AcousticFeatures>();

  private get inMemoryFeatures() {
    return AudioFeatureManager.sharedFeatures;
  }

  constructor(private readonly db: DatabaseClient | null = null) {
    logger.debug('AudioFeatureManager initialized');
  }

  /**
   * Save or update extracted acoustic features for a track.
   */
  async saveFeatures(features: Partial<AcousticFeatures> & { trackId: string }): Promise<AcousticFeatures> {
    const fullFeature: AcousticFeatures = {
      trackId: features.trackId,
      featureVersion: features.featureVersion ?? 1,
      embeddingVersion: features.embeddingVersion ?? 1,
      bpm: features.bpm ?? null,
      tempoConfidence: features.tempoConfidence ?? null,
      energy: features.energy ?? null,
      key: features.key ?? null,
      spectralCentroid: features.spectralCentroid ?? null,
      spectralBandwidth: features.spectralBandwidth ?? null,
      spectralContrast: features.spectralContrast ?? null,
      spectralRolloff: features.spectralRolloff ?? null,
      spectralFlatness: features.spectralFlatness ?? null,
      zeroCrossingRate: features.zeroCrossingRate ?? null,
      chroma: features.chroma ?? null,
      mfcc: features.mfcc ?? null,
      rhythmFeatures: features.rhythmFeatures ?? null,
      embedding: features.embedding ?? null,
      analysisStatus: features.analysisStatus ?? 'READY',
      contentHash: features.contentHash ?? null,
      analyzedAt: features.analyzedAt ?? new Date(),
      errorMessage: features.errorMessage ?? null,
      duration: features.duration ?? null,
    };

    if (!this.db) {
      this.inMemoryFeatures.set(features.trackId, fullFeature);
      return fullFeature;
    }

    try {
      const chromaStr = fullFeature.chroma ? JSON.stringify(fullFeature.chroma) : null;
      const mfccStr = fullFeature.mfcc ? JSON.stringify(fullFeature.mfcc) : null;
      const rhythmStr = fullFeature.rhythmFeatures ? JSON.stringify(fullFeature.rhythmFeatures) : null;
      const embeddingStr = fullFeature.embedding ? JSON.stringify(fullFeature.embedding) : null;

      // Upsert into track_features
      await this.db
        .insert(schema.trackFeatures)
        .values({
          trackId: fullFeature.trackId,
          featureVersion: fullFeature.featureVersion,
          bpm: fullFeature.bpm,
          tempoConfidence: fullFeature.tempoConfidence,
          energy: fullFeature.energy,
          key: fullFeature.key,
          spectralCentroid: fullFeature.spectralCentroid,
          spectralBandwidth: fullFeature.spectralBandwidth,
          spectralContrast: fullFeature.spectralContrast,
          spectralRolloff: fullFeature.spectralRolloff,
          spectralFlatness: fullFeature.spectralFlatness,
          zeroCrossingRate: fullFeature.zeroCrossingRate,
          chroma: chromaStr,
          mfcc: mfccStr,
          rhythmFeatures: rhythmStr,
          embedding: embeddingStr,
          analysisStatus: fullFeature.analysisStatus,
          contentHash: fullFeature.contentHash,
          analyzedAt: fullFeature.analyzedAt,
          errorMessage: fullFeature.errorMessage,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: schema.trackFeatures.trackId,
          set: {
            featureVersion: fullFeature.featureVersion,
            bpm: fullFeature.bpm,
            tempoConfidence: fullFeature.tempoConfidence,
            energy: fullFeature.energy,
            key: fullFeature.key,
            spectralCentroid: fullFeature.spectralCentroid,
            spectralBandwidth: fullFeature.spectralBandwidth,
            spectralContrast: fullFeature.spectralContrast,
            spectralRolloff: fullFeature.spectralRolloff,
            spectralFlatness: fullFeature.spectralFlatness,
            zeroCrossingRate: fullFeature.zeroCrossingRate,
            chroma: chromaStr,
            mfcc: mfccStr,
            rhythmFeatures: rhythmStr,
            embedding: embeddingStr,
            analysisStatus: fullFeature.analysisStatus,
            contentHash: fullFeature.contentHash,
            analyzedAt: fullFeature.analyzedAt,
            errorMessage: fullFeature.errorMessage,
            updatedAt: new Date(),
          },
        });

      // Also set pgvector vector_embedding if supported in PostgreSQL
      if (fullFeature.embedding && fullFeature.embedding.length > 0) {
        try {
          const vectorStr = `[${fullFeature.embedding.join(',')}]`;
          await this.db.execute(sql`
            UPDATE track_features
            SET vector_embedding = ${vectorStr}::vector
            WHERE track_id = ${fullFeature.trackId}
          `);
        } catch {
          // Ignore if pgvector column or extension is not present in environment
        }
      }

      this.inMemoryFeatures.set(features.trackId, fullFeature);
      return fullFeature;
    } catch (err) {
      logger.error({ err, trackId: features.trackId }, 'Failed to save track features to database');
      this.inMemoryFeatures.set(features.trackId, fullFeature);
      return fullFeature;
    }
  }

  /**
   * Retrieve acoustic features for a track.
   */
  async getFeatures(trackId: string): Promise<AcousticFeatures | null> {
    if (!this.db) {
      return this.inMemoryFeatures.get(trackId) || null;
    }

    try {
      const rows = await this.db
        .select()
        .from(schema.trackFeatures)
        .where(eq(schema.trackFeatures.trackId, trackId))
        .limit(1);

      if (rows.length === 0) {
        return this.inMemoryFeatures.get(trackId) || null;
      }

      return this.mapRowToFeatures(rows[0]);
    } catch (err) {
      logger.error({ err, trackId }, 'Failed to fetch track features from database');
      return this.inMemoryFeatures.get(trackId) || null;
    }
  }

  /**
   * Find existing features by audio content hash (deduplication & caching).
   */
  async findByContentHash(contentHash: string): Promise<AcousticFeatures | null> {
    if (!contentHash) return null;

    if (!this.db) {
      for (const feat of this.inMemoryFeatures.values()) {
        if (feat.contentHash === contentHash && feat.analysisStatus === 'READY') {
          return feat;
        }
      }
      return null;
    }

    try {
      const rows = await this.db
        .select()
        .from(schema.trackFeatures)
        .where(eq(schema.trackFeatures.contentHash, contentHash))
        .limit(1);

      if (rows.length === 0) {
        for (const feat of this.inMemoryFeatures.values()) {
          if (feat.contentHash === contentHash && feat.analysisStatus === 'READY') {
            return feat;
          }
        }
        return null;
      }

      return this.mapRowToFeatures(rows[0]);
    } catch (err) {
      logger.error({ err, contentHash }, 'Failed to lookup features by content hash');
      return null;
    }
  }

  /**
   * Update analysis status (e.g. PENDING, PROCESSING, READY, FAILED).
   */
  async setStatus(trackId: string, status: AnalysisStatus, error?: string): Promise<void> {
    const existing = await this.getFeatures(trackId);
    if (existing) {
      existing.analysisStatus = status;
      if (error) existing.errorMessage = error;
      if (status === 'READY') existing.analyzedAt = new Date();
      this.inMemoryFeatures.set(trackId, existing);
    } else {
      this.inMemoryFeatures.set(trackId, {
        trackId,
        featureVersion: 1,
        embeddingVersion: 1,
        bpm: null,
        tempoConfidence: null,
        energy: null,
        key: null,
        spectralCentroid: null,
        spectralBandwidth: null,
        spectralContrast: null,
        spectralRolloff: null,
        spectralFlatness: null,
        zeroCrossingRate: null,
        chroma: null,
        mfcc: null,
        rhythmFeatures: null,
        embedding: null,
        analysisStatus: status,
        contentHash: null,
        analyzedAt: status === 'READY' ? new Date() : null,
        errorMessage: error ?? null,
      });
    }

    if (!this.db) return;

    try {
      await this.db
        .insert(schema.trackFeatures)
        .values({
          trackId,
          analysisStatus: status,
          errorMessage: error ?? null,
          analyzedAt: status === 'READY' ? new Date() : null,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: schema.trackFeatures.trackId,
          set: {
            analysisStatus: status,
            errorMessage: error ?? null,
            analyzedAt: status === 'READY' ? new Date() : undefined,
            updatedAt: new Date(),
          },
        });
    } catch (err) {
      logger.error({ err, trackId, status }, 'Failed to update analysis status in database');
    }
  }

  /**
   * Retrieve all tracks with READY analysis features.
   */
  async getAllReadyFeatures(): Promise<Array<{ trackId: string; features: AcousticFeatures }>> {
    const result: Array<{ trackId: string; features: AcousticFeatures }> = [];

    if (!this.db) {
      for (const [trackId, feat] of this.inMemoryFeatures.entries()) {
        if (feat.analysisStatus === 'READY') {
          result.push({ trackId, features: feat });
        }
      }
      return result;
    }

    try {
      const rows = await this.db
        .select()
        .from(schema.trackFeatures)
        .where(eq(schema.trackFeatures.analysisStatus, 'READY'));

      for (const row of rows) {
        result.push({
          trackId: row.trackId,
          features: this.mapRowToFeatures(row),
        });
      }

      // Merge any in-memory features not yet in DB
      for (const [trackId, feat] of this.inMemoryFeatures.entries()) {
        if (feat.analysisStatus === 'READY' && !result.some((r) => r.trackId === trackId)) {
          result.push({ trackId, features: feat });
        }
      }

      return result;
    } catch (err) {
      logger.error({ err }, 'Failed to fetch all ready features from database');
      for (const [trackId, feat] of this.inMemoryFeatures.entries()) {
        if (feat.analysisStatus === 'READY') {
          result.push({ trackId, features: feat });
        }
      }
      return result;
    }
  }

  /**
   * Map raw SQL database row to AcousticFeatures domain object.
   */
  private mapRowToFeatures(row: TrackFeaturesRow): AcousticFeatures {
    let chroma: number[] | null = null;
    let mfcc: number[] | null = null;
    let rhythmFeatures: any = null;
    let embedding: number[] | null = null;

    try {
      if (row.chroma) chroma = JSON.parse(row.chroma);
    } catch {}

    try {
      if (row.mfcc) mfcc = JSON.parse(row.mfcc);
    } catch {}

    try {
      if (row.rhythmFeatures) rhythmFeatures = JSON.parse(row.rhythmFeatures);
    } catch {}

    try {
      if (row.embedding) embedding = JSON.parse(row.embedding);
    } catch {}

    return {
      trackId: row.trackId,
      featureVersion: row.featureVersion,
      embeddingVersion: 1,
      bpm: row.bpm,
      tempoConfidence: row.tempoConfidence,
      energy: row.energy,
      key: row.key,
      spectralCentroid: row.spectralCentroid,
      spectralBandwidth: row.spectralBandwidth,
      spectralContrast: row.spectralContrast,
      spectralRolloff: row.spectralRolloff,
      spectralFlatness: row.spectralFlatness,
      zeroCrossingRate: row.zeroCrossingRate,
      chroma,
      mfcc,
      rhythmFeatures,
      embedding,
      analysisStatus: row.analysisStatus as AnalysisStatus,
      contentHash: row.contentHash,
      analyzedAt: row.analyzedAt,
      errorMessage: row.errorMessage,
    };
  }
}
