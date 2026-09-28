import type { AudioFeatureManager } from './audio-feature.manager';
import type { TrackSimilarityService } from './track-similarity.service';
import type { PreferenceScoringService } from './preference-scoring.service';
import type { TrackManager } from './track.manager';
import type {
  AcousticFeatures,
  DJProfile,
  DJState,
  RecommendationCandidate,
  RecommendationResult,
} from '../types/recommendation';
import type { QueueTrack } from '../types/queue';
import { createLogger } from '../utils/logger';

const logger = createLogger('dynamic-dj');

export interface DynamicDJContext {
  guildId: string;
  seedTrackId?: string;
  activeUserIds?: string[];
  candidatePool?: Array<{
    trackId: string;
    title: string;
    artist: string | null;
    sourceUrl?: string | null;
    features?: AcousticFeatures | null;
  }>;
  queueTrackIds?: string[];
  limit?: number;
  profile?: DJProfile;
}

/**
 * Dynamic DJ & Smart Recommendation Manager.
 * Orchestrates similarity, listener preferences, energy continuity, and adaptive queueing.
 */
export class DynamicDJManager {
  private readonly guildStates = new Map<string, DJState>();
  private readonly defaultCooldownCount: number;

  constructor(
    private readonly featureManager: AudioFeatureManager,
    private readonly similarityService: TrackSimilarityService,
    private readonly preferenceService: PreferenceScoringService,
    private readonly trackManager: TrackManager,
    options: { recentCooldownCount?: number } = {},
    private readonly loggerInstance = logger,
  ) {
    this.defaultCooldownCount = options.recentCooldownCount ?? 10;
    this.loggerInstance.debug('DynamicDJManager initialized');
  }

  /**
   * Get or initialize the DJ state for a guild.
   */
  getDJState(guildId: string): DJState {
    let state = this.guildStates.get(guildId);
    if (!state) {
      state = {
        guildId,
        enabled: false,
        profile: 'BALANCED',
        lookaheadQueue: [],
        recentTrackIds: [],
        lastEnergy: null,
        lastBpm: null,
        updatedAt: new Date().toISOString(),
      };
      this.guildStates.set(guildId, state);
    }
    return state;
  }

  /**
   * Toggle or configure DJ mode for a guild.
   */
  configureDJ(guildId: string, options: { enabled?: boolean; profile?: DJProfile }): DJState {
    const state = this.getDJState(guildId);
    if (options.enabled !== undefined) state.enabled = options.enabled;
    if (options.profile !== undefined) state.profile = options.profile;
    state.updatedAt = new Date().toISOString();
    return state;
  }

  /**
   * Record a track play in the guild recent history for cooldown window enforcement.
   */
  recordPlayedTrack(guildId: string, trackId: string, features?: AcousticFeatures | null): void {
    const state = this.getDJState(guildId);
    state.recentTrackIds = [trackId, ...state.recentTrackIds.filter((id) => id !== trackId)].slice(
      0,
      this.defaultCooldownCount,
    );

    if (features) {
      if (features.energy !== null) state.lastEnergy = features.energy;
      if (features.bpm !== null) state.lastBpm = features.bpm;
    }

    // Drop chosen track from lookahead queue if present
    state.lookaheadQueue = state.lookaheadQueue.filter((c) => c.trackId !== trackId);
    state.updatedAt = new Date().toISOString();
  }

  /**
   * Dynamic next track selection pipeline.
   */
  async selectNextTrack(context: DynamicDJContext): Promise<RecommendationCandidate | null> {
    const state = this.getDJState(context.guildId);
    const profile = context.profile || state.profile;

    // Check if lookahead queue already has a pre-ranked candidate
    if (state.lookaheadQueue.length > 0) {
      const nextCandidate = state.lookaheadQueue.shift()!;
      this.loggerInstance.info(
        { guildId: context.guildId, trackId: nextCandidate.trackId, title: nextCandidate.title },
        '[DJ] Selected next track from lookahead queue',
      );
      return nextCandidate;
    }

    const recommendations = await this.generateRecommendations({
      ...context,
      limit: 3,
      profile,
    });

    if (recommendations.tracks.length === 0) {
      return null;
    }

    const selected = recommendations.tracks[0];
    // Keep remaining 1-2 tracks in the adaptive lookahead queue
    state.lookaheadQueue = recommendations.tracks.slice(1);
    state.updatedAt = new Date().toISOString();

    return selected;
  }

  /**
   * Core Recommendation Generation Pipeline:
   * 1. Candidate Retrieval & Filtering (removes current track, recent cooldown, broken sources)
   * 2. Cold-Start Hierarchy (Personal -> Guild -> Similarity -> Library Fallback)
   * 3. Acoustic Feature Analysis & Continuity Scoring
   * 4. Multi-User Preference Aggregation
   * 5. Explainable Ranking
   */
  async generateRecommendations(context: DynamicDJContext): Promise<RecommendationResult> {
    const state = this.getDJState(context.guildId);
    const profile = context.profile || state.profile;
    const limit = context.limit ?? 5;

    // 1. Gather all candidate tracks
    let allTracks = context.candidatePool;
    if (!allTracks || allTracks.length === 0) {
      const dbTracks = await this.trackManager.getAllTracks(200);
      allTracks = dbTracks.map((t) => ({
        trackId: t.id,
        title: t.title,
        artist: t.artist,
        sourceUrl: null,
      }));
    }

    // 2. Filter exclusions: current track, recent tracks, queue tracks
    const excludedIds = new Set<string>();
    if (context.seedTrackId) excludedIds.add(context.seedTrackId);
    for (const rId of state.recentTrackIds) excludedIds.add(rId);
    if (context.queueTrackIds) {
      for (const qId of context.queueTrackIds) excludedIds.add(qId);
    }

    let candidates = allTracks.filter((t) => !excludedIds.has(t.trackId));

    // If cooldown filtered out all candidates, relax recent track cooldown
    if (candidates.length === 0) {
      this.loggerInstance.warn({ guildId: context.guildId }, '[DJ] Candidate pool empty, relaxing recent cooldown');
      candidates = allTracks.filter((t) => t.trackId !== context.seedTrackId);
    }

    if (candidates.length === 0) {
      return {
        guildId: context.guildId,
        seedTrackId: context.seedTrackId,
        mode: 'dj',
        profile,
        tracks: [],
        algorithmVersion: 'v1',
        generatedAt: new Date().toISOString(),
      };
    }

    // 3. Resolve seed track features
    let seedFeatures: AcousticFeatures | null = null;
    if (context.seedTrackId) {
      seedFeatures = await this.featureManager.getFeatures(context.seedTrackId);
    }

    // Fallback seed features from DJ state last played track
    if (!seedFeatures && (state.lastEnergy !== null || state.lastBpm !== null)) {
      seedFeatures = {
        trackId: 'virtual-seed',
        featureVersion: 1,
        embeddingVersion: 1,
        bpm: state.lastBpm ?? 120,
        tempoConfidence: 0.5,
        energy: state.lastEnergy ?? 0.5,
        key: null,
        spectralCentroid: 2000,
        spectralBandwidth: 2000,
        spectralContrast: 20,
        spectralRolloff: 4000,
        spectralFlatness: 0.05,
        zeroCrossingRate: 0.05,
        chroma: null,
        mfcc: null,
        rhythmFeatures: null,
        embedding: null,
        analysisStatus: 'READY',
        contentHash: null,
        analyzedAt: new Date(),
        errorMessage: null,
      };
    }

    // 4. Score each candidate
    const scoredCandidates: RecommendationCandidate[] = [];

    for (const cand of candidates) {
      // Lookup features
      let candFeatures = cand.features;
      if (!candFeatures) {
        candFeatures = await this.featureManager.getFeatures(cand.trackId);
      }

      // Filter out unavailable / corrupted tracks (Requirement 18)
      if (candFeatures?.analysisStatus === 'FAILED') {
        continue;
      }

      // Acoustic similarity score
      let similarityScore = 0.5;
      let tempoScore = 0.5;
      let energyScore = 0.5;
      let reasons: string[] = [];
      let explanation = 'Recommended for you';

      if (seedFeatures && candFeatures && candFeatures.analysisStatus === 'READY') {
        const hybrid = this.similarityService.computeHybridSimilarity(seedFeatures, candFeatures, profile);
        similarityScore = hybrid.score;
        tempoScore = hybrid.details.tempoSim;
        energyScore = hybrid.details.energySim;
        reasons = [...hybrid.reasons];
        explanation = hybrid.explanation;
      } else if (candFeatures?.energy !== null && candFeatures?.energy !== undefined) {
        // Cold start without seed: evaluate energy fit for profile
        energyScore = this.similarityService.computeEnergyCompatibility(
          profile === 'CHILL' ? 0.3 : profile === 'ENERGETIC' ? 0.8 : 0.5,
          candFeatures.energy,
          profile,
        );
        similarityScore = energyScore;
        reasons.push(profile === 'CHILL' ? 'Chill acoustic energy' : profile === 'ENERGETIC' ? 'Upbeat energy' : 'Balanced vibe');
      }

      // Preference score: multi-user blended or guild history
      let preferenceScore = 0.0;
      if (context.activeUserIds && context.activeUserIds.length > 0) {
        const groupRes = await this.preferenceService.computeGroupPreference(
          context.guildId,
          cand.trackId,
          context.activeUserIds,
        );
        preferenceScore = groupRes.groupScore;
        if (preferenceScore > 0.4) reasons.push('Strong listener favorite');
      } else {
        preferenceScore = await this.preferenceService.computeGuildTrackPreference(context.guildId, cand.trackId);
        if (preferenceScore > 0.4) reasons.push('Frequently enjoyed on this server');
      }

      // Novelty score: bonus if not played recently
      const wasPlayedRecently = state.recentTrackIds.includes(cand.trackId);
      const noveltyScore = wasPlayedRecently ? 0.2 : 0.8;

      // Final weighted ranking formula
      // finalScore = 0.50 * similarity + 0.30 * preference + 0.20 * novelty
      // Map preference from [-1, 1] to [0, 1]
      const normalizedPref = (preferenceScore + 1.0) / 2.0;
      const finalScore = Math.round(
        (0.50 * similarityScore + 0.30 * normalizedPref + 0.20 * noveltyScore) * 1000,
      ) / 1000;

      // Internal explainable logging (Section 38 requirement)
      this.loggerInstance.debug(
        {
          candidate: cand.title,
          trackId: cand.trackId,
          similarityScore,
          preferenceScore,
          noveltyScore,
          tempoScore,
          energyScore,
          finalScore,
          algorithmVersion: 'v1',
        },
        '[REC] Evaluated candidate',
      );

      scoredCandidates.push({
        trackId: cand.trackId,
        title: cand.title,
        artist: cand.artist,
        sourceUrl: cand.sourceUrl ?? null,
        features: candFeatures,
        similarityScore,
        preferenceScore,
        tempoScore,
        energyScore,
        noveltyScore,
        finalScore,
        reasons,
        explanation,
        algorithmVersion: 'v1',
      });
    }

    // 5. Rank and return top tracks
    const ranked = scoredCandidates.sort((a, b) => b.finalScore - a.finalScore).slice(0, limit);

    return {
      guildId: context.guildId,
      seedTrackId: context.seedTrackId,
      mode: 'dj',
      profile,
      tracks: ranked,
      algorithmVersion: 'v1',
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Smart Shuffle (Requirement 19):
   * Intelligently reorders queue items using acoustic continuity, listener preferences,
   * and controlled randomness (softmax temperature sampling) rather than pure random shuffle.
   */
  async smartShuffle(
    guildId: string,
    queue: QueueTrack[],
    currentTrack?: QueueTrack | null,
    profile: DJProfile = 'BALANCED',
  ): Promise<QueueTrack[]> {
    if (queue.length <= 1) return [...queue];

    const state = this.getDJState(guildId);
    let currentEnergy = state.lastEnergy ?? 0.5;
    let currentBpm = state.lastBpm ?? 120;

    if (currentTrack?.trackId) {
      const currentFeat = await this.featureManager.getFeatures(currentTrack.trackId);
      if (currentFeat) {
        if (currentFeat.energy !== null) currentEnergy = currentFeat.energy;
        if (currentFeat.bpm !== null) currentBpm = currentFeat.bpm;
      }
    }

    const remaining = [...queue];
    const ordered: QueueTrack[] = [];

    // Iteratively select the next best track using softmax temperature sampling
    while (remaining.length > 0) {
      if (remaining.length === 1) {
        ordered.push(remaining[0]);
        break;
      }

      // Compute continuity score for each remaining item
      const scores: number[] = [];
      const featsList: Array<AcousticFeatures | null> = [];

      for (const item of remaining) {
        const feat = item.trackId ? await this.featureManager.getFeatures(item.trackId) : null;
        featsList.push(feat);

        let energyDiff = 0.5;
        let tempoComp = 0.5;

        if (feat) {
          if (feat.energy !== null) {
            energyDiff = this.similarityService.computeEnergyCompatibility(currentEnergy, feat.energy, profile);
          }
          if (feat.bpm !== null) {
            tempoComp = this.similarityService.computeTempoCompatibility(currentBpm, feat.bpm);
          }
        }

        // Higher continuity score = smoother transition
        const score = 0.6 * energyDiff + 0.4 * tempoComp;
        scores.push(score);
      }

      // Softmax with temperature T = 0.4 for controlled stochasticity
      const temperature = 0.4;
      const expScores = scores.map((s) => Math.exp(s / temperature));
      const sumExp = expScores.reduce((a, b) => a + b, 0);
      const probabilities = expScores.map((e) => e / sumExp);

      // Weighted random selection
      const rand = Math.random();
      let cumulative = 0.0;
      let chosenIndex = 0;

      for (let i = 0; i < probabilities.length; i++) {
        cumulative += probabilities[i];
        if (rand <= cumulative) {
          chosenIndex = i;
          break;
        }
      }

      const chosenTrack = remaining.splice(chosenIndex, 1)[0];
      const chosenFeat = featsList[chosenIndex];

      ordered.push(chosenTrack);

      if (chosenFeat) {
        if (chosenFeat.energy !== null) currentEnergy = chosenFeat.energy;
        if (chosenFeat.bpm !== null) currentBpm = chosenFeat.bpm;
      }
    }

    this.loggerInstance.info(
      { guildId, count: ordered.length, profile },
      '[DJ] Smart shuffle completed successfully',
    );

    return ordered;
  }
}
