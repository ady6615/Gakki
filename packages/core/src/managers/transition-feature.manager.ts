import { eq } from 'drizzle-orm';
import type { DatabaseClient } from '../database/connection';
import * as schema from '../database/schema';
import type { TrackTransitionFeatures } from '../types/transition';
import { createLogger } from '../utils/logger';

const logger = createLogger('transition-feature-manager');

export type TrackTransitionFeaturesRow = typeof schema.trackTransitionFeatures.$inferSelect;

export class TransitionFeatureManager {
  // Process-wide shared memory store for tests / offline mode
  private static readonly sharedFeatures = new Map<string, TrackTransitionFeatures>();

  private get inMemoryFeatures() {
    return TransitionFeatureManager.sharedFeatures;
  }

  constructor(private readonly db: DatabaseClient | null = null) {
    logger.debug('TransitionFeatureManager initialized');
  }

  /**
   * Save or update transition features for a track.
   */
  async saveFeatures(
    features: Partial<TrackTransitionFeatures> & { trackId: string },
  ): Promise<TrackTransitionFeatures> {
    const fullFeature: TrackTransitionFeatures = {
      trackId: features.trackId,
      featureVersion: features.featureVersion ?? 1,
      integratedLoudnessLufs: features.integratedLoudnessLufs ?? null,
      loudnessRangeLu: features.loudnessRangeLu ?? null,
      truePeakDbtp: features.truePeakDbtp ?? null,
      trackGainDb: features.trackGainDb ?? null,
      beatGrid: features.beatGrid ?? null,
      beatConfidence: features.beatConfidence ?? null,
      phraseBoundaries: features.phraseBoundaries ?? null,
      introStart: features.introStart ?? null,
      introEnd: features.introEnd ?? null,
      introEnergy: features.introEnergy ?? null,
      outroStart: features.outroStart ?? null,
      outroEnd: features.outroEnd ?? null,
      outroEnergy: features.outroEnergy ?? null,
      dropCandidates: features.dropCandidates ?? null,
      key: features.key ?? null,
      keyConfidence: features.keyConfidence ?? null,
      camelotCode: features.camelotCode ?? null,
      structureConfidence: features.structureConfidence ?? null,
      analysisStatus: features.analysisStatus ?? 'READY',
      analyzedAt: features.analyzedAt ?? new Date(),
      errorMessage: features.errorMessage ?? null,
    };

    if (!this.db) {
      this.inMemoryFeatures.set(features.trackId, fullFeature);
      return fullFeature;
    }

    try {
      const beatGridStr = fullFeature.beatGrid ? JSON.stringify(fullFeature.beatGrid) : null;
      const phraseStr = fullFeature.phraseBoundaries ? JSON.stringify(fullFeature.phraseBoundaries) : null;
      const dropsStr = fullFeature.dropCandidates ? JSON.stringify(fullFeature.dropCandidates) : null;

      await this.db
        .insert(schema.trackTransitionFeatures)
        .values({
          trackId: fullFeature.trackId,
          featureVersion: fullFeature.featureVersion,
          integratedLoudnessLufs: fullFeature.integratedLoudnessLufs,
          loudnessRangeLu: fullFeature.loudnessRangeLu,
          truePeakDbtp: fullFeature.truePeakDbtp,
          trackGainDb: fullFeature.trackGainDb,
          beatGrid: beatGridStr,
          beatConfidence: fullFeature.beatConfidence,
          phraseBoundaries: phraseStr,
          introStart: fullFeature.introStart,
          introEnd: fullFeature.introEnd,
          introEnergy: fullFeature.introEnergy,
          outroStart: fullFeature.outroStart,
          outroEnd: fullFeature.outroEnd,
          outroEnergy: fullFeature.outroEnergy,
          dropCandidates: dropsStr,
          key: fullFeature.key,
          keyConfidence: fullFeature.keyConfidence,
          camelotCode: fullFeature.camelotCode,
          structureConfidence: fullFeature.structureConfidence,
          analysisStatus: fullFeature.analysisStatus,
          analyzedAt: fullFeature.analyzedAt,
          errorMessage: fullFeature.errorMessage,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: schema.trackTransitionFeatures.trackId,
          set: {
            featureVersion: fullFeature.featureVersion,
            integratedLoudnessLufs: fullFeature.integratedLoudnessLufs,
            loudnessRangeLu: fullFeature.loudnessRangeLu,
            truePeakDbtp: fullFeature.truePeakDbtp,
            trackGainDb: fullFeature.trackGainDb,
            beatGrid: beatGridStr,
            beatConfidence: fullFeature.beatConfidence,
            phraseBoundaries: phraseStr,
            introStart: fullFeature.introStart,
            introEnd: fullFeature.introEnd,
            introEnergy: fullFeature.introEnergy,
            outroStart: fullFeature.outroStart,
            outroEnd: fullFeature.outroEnd,
            outroEnergy: fullFeature.outroEnergy,
            dropCandidates: dropsStr,
            key: fullFeature.key,
            keyConfidence: fullFeature.keyConfidence,
            camelotCode: fullFeature.camelotCode,
            structureConfidence: fullFeature.structureConfidence,
            analysisStatus: fullFeature.analysisStatus,
            analyzedAt: fullFeature.analyzedAt,
            errorMessage: fullFeature.errorMessage,
            updatedAt: new Date(),
          },
        });

      return fullFeature;
    } catch (err) {
      logger.warn({ err, trackId: features.trackId }, 'Failed to persist transition features to DB, using memory fallback');
      this.inMemoryFeatures.set(features.trackId, fullFeature);
      return fullFeature;
    }
  }

  /**
   * Retrieve transition features for a track.
   */
  async getFeatures(trackId: string): Promise<TrackTransitionFeatures | null> {
    if (!this.db) {
      return this.inMemoryFeatures.get(trackId) ?? null;
    }

    try {
      const rows = await this.db
        .select()
        .from(schema.trackTransitionFeatures)
        .where(eq(schema.trackTransitionFeatures.trackId, trackId))
        .limit(1);

      if (rows.length === 0) {
        return this.inMemoryFeatures.get(trackId) ?? null;
      }

      return this.mapRowToFeatures(rows[0]);
    } catch (err) {
      logger.warn({ err, trackId }, 'Failed to query transition features from DB, checking memory store');
      return this.inMemoryFeatures.get(trackId) ?? null;
    }
  }

  /**
   * Set analysis status for a track.
   */
  async setStatus(
    trackId: string,
    status: 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED',
    errorMessage?: string,
  ): Promise<void> {
    const existing = await this.getFeatures(trackId);
    if (existing) {
      await this.saveFeatures({
        ...existing,
        analysisStatus: status,
        errorMessage: errorMessage ?? null,
      });
    } else {
      await this.saveFeatures({
        trackId,
        analysisStatus: status,
        errorMessage: errorMessage ?? null,
      });
    }
  }

  private mapRowToFeatures(row: TrackTransitionFeaturesRow): TrackTransitionFeatures {
    let beatGrid: number[] | null = null;
    let phraseBoundaries = null;
    let dropCandidates: number[] | null = null;

    try {
      if (row.beatGrid) beatGrid = JSON.parse(row.beatGrid);
    } catch {}

    try {
      if (row.phraseBoundaries) phraseBoundaries = JSON.parse(row.phraseBoundaries);
    } catch {}

    try {
      if (row.dropCandidates) dropCandidates = JSON.parse(row.dropCandidates);
    } catch {}

    return {
      trackId: row.trackId,
      featureVersion: row.featureVersion,
      integratedLoudnessLufs: row.integratedLoudnessLufs,
      loudnessRangeLu: row.loudnessRangeLu,
      truePeakDbtp: row.truePeakDbtp,
      trackGainDb: row.trackGainDb,
      beatGrid,
      beatConfidence: row.beatConfidence,
      phraseBoundaries,
      introStart: row.introStart,
      introEnd: row.introEnd,
      introEnergy: row.introEnergy,
      outroStart: row.outroStart,
      outroEnd: row.outroEnd,
      outroEnergy: row.outroEnergy,
      dropCandidates,
      key: row.key,
      keyConfidence: row.keyConfidence,
      camelotCode: row.camelotCode,
      structureConfidence: row.structureConfidence,
      analysisStatus: row.analysisStatus as any,
      analyzedAt: row.analyzedAt,
      errorMessage: row.errorMessage,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
