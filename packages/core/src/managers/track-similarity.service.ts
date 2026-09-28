import type {
  AcousticFeatures,
  DJProfile,
  RecommendationCandidate,
  RecommendationProfileConfig,
} from '../types/recommendation';
import { createLogger } from '../utils/logger';

const logger = createLogger('track-similarity');

export const DEFAULT_REC_PROFILES: Record<DJProfile, RecommendationProfileConfig> = {
  BALANCED: {
    version: 'v1-balanced',
    vectorWeight: 0.35,
    tempoWeight: 0.20,
    energyWeight: 0.20,
    rhythmWeight: 0.15,
    harmonicWeight: 0.10,
    preferenceWeight: 0.25,
    noveltyWeight: 0.10,
    recentCooldownCount: 10,
  },
  CHILL: {
    version: 'v1-chill',
    vectorWeight: 0.40,
    tempoWeight: 0.20,
    energyWeight: 0.25,
    rhythmWeight: 0.10,
    harmonicWeight: 0.05,
    preferenceWeight: 0.20,
    noveltyWeight: 0.10,
    recentCooldownCount: 10,
  },
  ENERGETIC: {
    version: 'v1-energetic',
    vectorWeight: 0.30,
    tempoWeight: 0.25,
    energyWeight: 0.25,
    rhythmWeight: 0.15,
    harmonicWeight: 0.05,
    preferenceWeight: 0.25,
    noveltyWeight: 0.10,
    recentCooldownCount: 10,
  },
};

// Circle of Fifths order for Key Distance calculation
const FIFTHS_ORDER: Record<string, number> = {
  C: 0,
  G: 1,
  D: 2,
  A: 3,
  E: 4,
  B: 5,
  'F#': 6,
  'C#': 7,
  'G#': 8,
  'D#': 9,
  'A#': 10,
  F: 11,
};

/**
 * Deterministic, measurable audio track similarity service.
 * Implements hybrid similarity: Vector + Tempo + Energy + Rhythm + Harmonic.
 */
export class TrackSimilarityService {
  constructor(private readonly loggerInstance = logger) {
    this.loggerInstance.debug('TrackSimilarityService initialized');
  }

  /**
   * Compute cosine similarity between two numerical vectors.
   */
  computeCosineSimilarity(a: number[] | null | undefined, b: number[] | null | undefined): number {
    if (!a || !b || a.length === 0 || b.length === 0 || a.length !== b.length) {
      return 0.5; // neutral fallback
    }

    let dot = 0.0;
    let normA = 0.0;
    let normB = 0.0;

    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    if (denom < 1e-8) return 0.5;
    const sim = dot / denom;
    return Math.max(0.0, Math.min(1.0, (sim + 1.0) / 2.0)); // scale from [-1, 1] to [0, 1]
  }

  /**
   * Compute tempo compatibility accounting for double-time / half-time ambiguity.
   * e.g. 72 BPM ≈ 144 BPM, 90 BPM ≈ 180 BPM.
   */
  computeTempoCompatibility(bpmA: number | null | undefined, bpmB: number | null | undefined): number {
    if (!bpmA || !bpmB || bpmA <= 0 || bpmB <= 0) {
      return 0.5; // neutral when unknown
    }

    // Direct difference ratio
    const diffDirect = Math.abs(bpmA - bpmB) / bpmA;
    // Half-time difference (B is ~half of A)
    const diffHalf = Math.abs(bpmA - 2 * bpmB) / bpmA;
    // Double-time difference (B is ~double of A)
    const diffDouble = Math.abs(2 * bpmA - bpmB) / (2 * bpmA);

    const minDiff = Math.min(diffDirect, diffHalf, diffDouble);

    // Tolerance window: within 15% is compatible, smoothly dropping off to 30%
    if (minDiff <= 0.04) return 1.0;
    if (minDiff <= 0.12) return 1.0 - (minDiff - 0.04) * 3.0;
    if (minDiff <= 0.25) return Math.max(0.1, 0.76 - (minDiff - 0.12) * 4.0);
    return Math.max(0.0, 0.24 - (minDiff - 0.25) * 1.5);
  }

  /**
   * Compute energy compatibility based on current DJ profile.
   */
  computeEnergyCompatibility(
    energyA: number | null | undefined,
    energyB: number | null | undefined,
    profile: DJProfile = 'BALANCED',
  ): number {
    const eA = energyA ?? 0.5;
    const eB = energyB ?? 0.5;
    const delta = Math.abs(eA - eB);

    if (profile === 'CHILL') {
      // Penalize higher energy songs and large energy jumps
      const chillBonus = eB <= 0.4 ? 1.0 : Math.max(0.1, 1.0 - (eB - 0.4) * 2.0);
      const deltaPenalty = Math.exp(-6.0 * delta);
      return 0.5 * chillBonus + 0.5 * deltaPenalty;
    }

    if (profile === 'ENERGETIC') {
      // Favor maintaining high energy (>= 0.6)
      const energyBonus = eB >= 0.6 ? 1.0 : Math.max(0.2, eB / 0.6);
      const deltaPenalty = Math.exp(-3.5 * delta);
      return 0.5 * energyBonus + 0.5 * deltaPenalty;
    }

    // BALANCED: Smooth energy transition curve
    return Math.exp(-4.0 * delta);
  }

  /**
   * Compute harmonic compatibility using musical key distance and/or chroma cosine similarity.
   */
  computeHarmonicCompatibility(
    keyA: string | null | undefined,
    keyB: string | null | undefined,
    chromaA?: number[] | null,
    chromaB?: number[] | null,
  ): number {
    if (chromaA && chromaB && chromaA.length === 12 && chromaB.length === 12) {
      return this.computeCosineSimilarity(chromaA, chromaB);
    }

    if (!keyA || !keyB || keyA === 'Unknown' || keyB === 'Unknown') {
      return 0.5;
    }

    const isMinorA = keyA.endsWith('m');
    const isMinorB = keyB.endsWith('m');
    const rootA = isMinorA ? keyA.slice(0, -1) : keyA;
    const rootB = isMinorB ? keyB.slice(0, -1) : keyB;

    const fifthA = FIFTHS_ORDER[rootA] ?? 0;
    const fifthB = FIFTHS_ORDER[rootB] ?? 0;

    let fifthDiff = Math.abs(fifthA - fifthB);
    if (fifthDiff > 6) fifthDiff = 12 - fifthDiff;

    let score = 1.0 - fifthDiff / 6.0;

    // Relative major/minor bonus (e.g. Am and C share the same scale!)
    if (isMinorA !== isMinorB) {
      // Relative key offset is 3 semitones (or 3 fifth steps)
      const relativeFifthDiff = Math.abs((fifthA + 3) % 12 - fifthB);
      if (relativeFifthDiff === 0 || relativeFifthDiff === 12) {
        score = Math.max(score, 0.9);
      } else {
        score *= 0.85; // slight penalty for mode change
      }
    }

    return Math.max(0.0, Math.min(1.0, score));
  }

  /**
   * Compute rhythm compatibility (onset strength & beat regularity).
   */
  computeRhythmCompatibility(featA: AcousticFeatures | null, featB: AcousticFeatures | null): number {
    if (!featA?.rhythmFeatures || !featB?.rhythmFeatures) {
      return 0.5;
    }

    const regA = featA.rhythmFeatures.beatRegularity ?? 0.5;
    const regB = featB.rhythmFeatures.beatRegularity ?? 0.5;
    const regDiff = Math.abs(regA - regB);

    const onsetA = featA.rhythmFeatures.onsetStrengthMean ?? 1.0;
    const onsetB = featB.rhythmFeatures.onsetStrengthMean ?? 1.0;
    const onsetDiff = Math.abs(onsetA - onsetB) / Math.max(onsetA, 0.1);

    const sim = 0.5 * (1.0 - Math.min(1.0, regDiff)) + 0.5 * Math.max(0.0, 1.0 - onsetDiff * 0.5);
    return Math.max(0.0, Math.min(1.0, sim));
  }

  /**
   * Compute full hybrid similarity between seed features and candidate features.
   */
  computeHybridSimilarity(
    seed: AcousticFeatures,
    candidate: AcousticFeatures,
    profile: DJProfile = 'BALANCED',
    config?: RecommendationProfileConfig,
  ): { score: number; details: Record<string, number>; reasons: string[]; explanation: string } {
    const cfg = config || DEFAULT_REC_PROFILES[profile] || DEFAULT_REC_PROFILES.BALANCED;

    // 1. Vector similarity (embedding)
    const vectorSim = this.computeCosineSimilarity(seed.embedding, candidate.embedding);

    // 2. Tempo compatibility
    const tempoSim = this.computeTempoCompatibility(seed.bpm, candidate.bpm);

    // 3. Energy compatibility
    const energySim = this.computeEnergyCompatibility(seed.energy, candidate.energy, profile);

    // 4. Harmonic compatibility
    const harmonicSim = this.computeHarmonicCompatibility(seed.key, candidate.key, seed.chroma, candidate.chroma);

    // 5. Rhythm compatibility
    const rhythmSim = this.computeRhythmCompatibility(seed, candidate);

    // Weighted combination
    const totalWeights =
      cfg.vectorWeight + cfg.tempoWeight + cfg.energyWeight + cfg.rhythmWeight + cfg.harmonicWeight;

    const hybridScore =
      (cfg.vectorWeight * vectorSim +
        cfg.tempoWeight * tempoSim +
        cfg.energyWeight * energySim +
        cfg.rhythmWeight * rhythmSim +
        cfg.harmonicWeight * harmonicSim) /
      totalWeights;

    // Explainable reasons
    const reasons: string[] = [];
    if (vectorSim >= 0.75) reasons.push('Strong acoustic similarity');
    if (tempoSim >= 0.8) {
      const isDouble = seed.bpm && candidate.bpm && Math.abs(candidate.bpm - 2 * seed.bpm) / seed.bpm < 0.15;
      const isHalf = seed.bpm && candidate.bpm && Math.abs(2 * candidate.bpm - seed.bpm) / seed.bpm < 0.15;
      if (isDouble) {
        reasons.push(`Double-time tempo match (~${Math.round(candidate.bpm!)} BPM ≈ 2× ${Math.round(seed.bpm!)} BPM)`);
      } else if (isHalf) {
        reasons.push(`Half-time tempo match (~${Math.round(candidate.bpm!)} BPM ≈ ½ ${Math.round(seed.bpm!)} BPM)`);
      } else {
        reasons.push(`Compatible tempo (~${Math.round(candidate.bpm || 0)} BPM)`);
      }
    }
    if (energySim >= 0.8) reasons.push('Smooth acoustic energy transition');
    if (harmonicSim >= 0.8 && candidate.key && seed.key) {
      reasons.push(`Harmonic key match (${seed.key} → ${candidate.key})`);
    }
    if (rhythmSim >= 0.75) reasons.push('Similar rhythmic pattern');

    if (reasons.length === 0) {
      reasons.push('General library match');
    }

    // Simplified UI explanation
    let explanation = 'Similar rhythm and energy to current track';
    if (vectorSim > 0.8 && tempoSim > 0.8) {
      explanation = 'Close acoustic match with compatible tempo';
    } else if (energySim > 0.85) {
      explanation = 'Seamless energy transition';
    } else if (harmonicSim > 0.85) {
      explanation = 'Complementary harmonic structure';
    }

    return {
      score: Math.round(hybridScore * 1000) / 1000,
      details: {
        vectorSim: Math.round(vectorSim * 1000) / 1000,
        tempoSim: Math.round(tempoSim * 1000) / 1000,
        energySim: Math.round(energySim * 1000) / 1000,
        harmonicSim: Math.round(harmonicSim * 1000) / 1000,
        rhythmSim: Math.round(rhythmSim * 1000) / 1000,
      },
      reasons,
      explanation,
    };
  }

  /**
   * Find most similar tracks to a seed track from a candidate set.
   */
  findSimilarTracks(
    seedFeatures: AcousticFeatures,
    candidates: Array<{ trackId: string; title: string; artist: string | null; sourceUrl?: string | null; features: AcousticFeatures }>,
    limit: number = 10,
    profile: DJProfile = 'BALANCED',
  ): RecommendationCandidate[] {
    const scored: RecommendationCandidate[] = [];

    for (const c of candidates) {
      if (c.trackId === seedFeatures.trackId) continue; // exclude self

      const hybrid = this.computeHybridSimilarity(seedFeatures, c.features, profile);

      scored.push({
        trackId: c.trackId,
        title: c.title,
        artist: c.artist,
        sourceUrl: c.sourceUrl ?? null,
        features: c.features,
        similarityScore: hybrid.score,
        preferenceScore: 0.0,
        tempoScore: hybrid.details.tempoSim,
        energyScore: hybrid.details.energySim,
        noveltyScore: 0.5,
        finalScore: hybrid.score,
        reasons: hybrid.reasons,
        explanation: hybrid.explanation,
        algorithmVersion: DEFAULT_REC_PROFILES[profile].version,
      });
    }

    // Sort descending by similarity
    return scored.sort((a, b) => b.finalScore - a.finalScore).slice(0, limit);
  }
}
