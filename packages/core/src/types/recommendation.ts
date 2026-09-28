/**
 * Audio analysis, smart recommendations, and dynamic DJ types.
 */

export type AnalysisStatus = 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED';

export type DJProfile = 'CHILL' | 'BALANCED' | 'ENERGETIC';

export interface AcousticFeatures {
  trackId: string;
  featureVersion: number;
  embeddingVersion: number;
  bpm: number | null;
  tempoConfidence: number | null;
  energy: number | null; // normalized acoustic energy [0, 1]
  key: string | null; // musical key estimate, e.g. 'C', 'Am'
  spectralCentroid: number | null;
  spectralBandwidth: number | null;
  spectralContrast: number | null;
  spectralRolloff: number | null;
  spectralFlatness: number | null;
  zeroCrossingRate: number | null;
  chroma: number[] | null; // 12-dim pitch class profile
  mfcc: number[] | null; // 13-dim MFCC means
  rhythmFeatures: {
    onsetStrengthMean?: number;
    beatRegularity?: number;
    harmonicRms?: number;
    percussiveRms?: number;
    harmonicPercussiveRatio?: number;
    beatCount?: number;
    [key: string]: any;
  } | null;
  embedding: number[] | null; // 32-dim normalized vector
  analysisStatus: AnalysisStatus;
  contentHash: string | null;
  analyzedAt: Date | null;
  errorMessage: string | null;
  duration?: number | null;
}

export interface RecommendationProfileConfig {
  version: string;
  vectorWeight: number;
  tempoWeight: number;
  energyWeight: number;
  rhythmWeight: number;
  harmonicWeight: number;
  preferenceWeight: number;
  noveltyWeight: number;
  recentCooldownCount: number;
}

export interface RecommendationCandidate {
  trackId: string;
  title: string;
  artist: string | null;
  sourceUrl: string | null;
  features: AcousticFeatures | null;
  similarityScore: number;
  preferenceScore: number;
  tempoScore: number;
  energyScore: number;
  noveltyScore: number;
  finalScore: number;
  reasons: string[];
  explanation: string;
  algorithmVersion: string;
}

export interface RecommendationResult {
  guildId: string;
  seedTrackId?: string;
  mode: 'similar' | 'vibe' | 'smart-shuffle' | 'dj';
  profile: DJProfile | string;
  tracks: RecommendationCandidate[];
  algorithmVersion: string;
  generatedAt: string;
}

export interface DJState {
  guildId: string;
  enabled: boolean;
  profile: DJProfile;
  lookaheadQueue: RecommendationCandidate[];
  recentTrackIds: string[];
  lastEnergy: number | null;
  lastBpm: number | null;
  updatedAt: string;
}
