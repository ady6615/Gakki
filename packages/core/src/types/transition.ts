/**
 * Phase 8: Seamless Audio Mixing, Crossfading & Advanced DJ Transitions
 * Core Types & Interfaces
 */

export type TransitionProfile = 'SMOOTH' | 'BALANCED' | 'ENERGETIC';

export type FallbackLevel = 'ADVANCED' | 'CROSSFADE' | 'SIMPLE_FADE' | 'HARD_CUT';

export type CueStrategy = 'PHRASE_ALIGNED' | 'BEAT_ALIGNED' | 'OUTRO_INTRO_BOUND' | 'DURATION_FALLBACK';

export interface PhraseBoundaries {
  fourBeats?: number[];
  eightBeats?: number[];
  sixteenBeats?: number[];
  thirtyTwoBeats?: number[];
}

export interface TrackTransitionFeatures {
  trackId: string;
  featureVersion: number;
  integratedLoudnessLufs: number | null;
  loudnessRangeLu: number | null;
  truePeakDbtp: number | null;
  trackGainDb: number | null;
  beatGrid: number[] | null;
  beatConfidence: number | null;
  phraseBoundaries: PhraseBoundaries | null;
  introStart: number | null;
  introEnd: number | null;
  introEnergy: number | null;
  outroStart: number | null;
  outroEnd: number | null;
  outroEnergy: number | null;
  dropCandidates: number[] | null;
  key: string | null;
  keyConfidence: number | null;
  camelotCode: string | null;
  structureConfidence: number | null;
  analysisStatus: 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED';
  analyzedAt?: Date | null;
  errorMessage?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface TransitionProfileConfig {
  name: TransitionProfile;
  defaultDurationSeconds: number;
  minDurationSeconds: number;
  maxDurationSeconds: number;
  curve: string; // e.g. 'qsin' (quarter-sine equal power), 'hsin' (half-sine)
  preferredPhraseBars: number; // 4, 8, 16, 32 bars
  maxTempoAdjustmentPercent: number; // e.g. 3.0%
  requireHarmonicMatch: boolean;
  minKeyConfidence: number; // 0.6
  energyTolerance: number; // 0.3
}

export const TRANSITION_PROFILES: Record<TransitionProfile, TransitionProfileConfig> = {
  SMOOTH: {
    name: 'SMOOTH',
    defaultDurationSeconds: 8,
    minDurationSeconds: 4,
    maxDurationSeconds: 8,
    curve: 'qsin', // equal-power quarter sine
    preferredPhraseBars: 32,
    maxTempoAdjustmentPercent: 2.0,
    requireHarmonicMatch: true,
    minKeyConfidence: 0.6,
    energyTolerance: 0.25,
  },
  BALANCED: {
    name: 'BALANCED',
    defaultDurationSeconds: 6,
    minDurationSeconds: 2,
    maxDurationSeconds: 8,
    curve: 'qsin', // equal-power quarter sine
    preferredPhraseBars: 16,
    maxTempoAdjustmentPercent: 3.0,
    requireHarmonicMatch: false,
    minKeyConfidence: 0.5,
    energyTolerance: 0.4,
  },
  ENERGETIC: {
    name: 'ENERGETIC',
    defaultDurationSeconds: 3,
    minDurationSeconds: 1,
    maxDurationSeconds: 5,
    curve: 'hsin', // half-sine for punchy overlap
    preferredPhraseBars: 8,
    maxTempoAdjustmentPercent: 3.5,
    requireHarmonicMatch: false,
    minKeyConfidence: 0.4,
    energyTolerance: 0.6,
  },
};

export type KeyRelationship =
  | 'SAME_KEY'
  | 'RELATIVE_MAJOR_MINOR'
  | 'ADJACENT_FIFTH'
  | 'DIAGONAL'
  | 'MODULATION'
  | 'INCOMPATIBLE';

export interface KeyCompatibilityResult {
  outgoingKey: string;
  incomingKey: string;
  outgoingCamelot: string;
  incomingCamelot: string;
  relationship: KeyRelationship;
  compatibilityScore: number; // 0.0 to 1.0
  pitchShiftSemitones: number; // -1, 0, +1
  shiftApplied: boolean;
  explanation: string;
}

export interface CuePointSelection {
  outgoingCueSeconds: number;
  incomingCueSeconds: number;
  durationSeconds: number;
  alignedToBeat: boolean;
  phraseMatched: boolean;
  strategy: CueStrategy;
  score: number;
  explanation: string;
}

export interface TransitionPlan {
  id: string;
  guildId: string;
  fromTrackId: string;
  toTrackId: string;
  profile: TransitionProfile;
  durationSeconds: number;
  curve: string;
  overlap: boolean;
  outgoingCueSeconds: number;
  incomingCueSeconds: number;
  tempoAdjustmentPercent: number; // e.g. +1.6%
  pitchShiftSemitones: number; // -1, 0, +1
  fromTrackGainDb: number;
  toTrackGainDb: number;
  loudnessProfileApplied?: boolean;
  fallbackLevel: FallbackLevel;
  algorithmVersion: string;
  score: number;
  explanation: string;
}

export interface GuildTransitionSettings {
  guildId: string;
  transitionEnabled: boolean;
  transitionDuration: number; // 1 to 8
  transitionProfile: TransitionProfile;
  harmonicMixing: boolean;
  autoTempo: boolean;
  loudnessNormalize: boolean;
}

export interface TransitionMetrics {
  transitionPreparationTimeMs: number;
  transitionRenderTimeMs: number;
  bufferUnderruns: number;
  transitionGapMs: number;
  fallbackCount: number;
  pitchShiftCount: number;
  tempoAdjustmentPercent: number;
  crossfadeDuration: number;
}
