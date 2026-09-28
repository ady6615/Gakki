/**
 * Phase 9: Stem Separation, Vocal Clash Prevention & Layered DJ Mixing
 * Core Types & Interfaces
 */

import type { TransitionPlan } from './transition';

export type StemType = 'vocals' | 'drums' | 'bass' | 'other';

export interface CanonicalStemSet {
  vocals: string; // Absolute file path or URI
  drums: string;
  bass: string;
  other: string;
}

export interface StemQualityScore {
  vocalConfidence: number; // 0.0 - 1.0
  drumConfidence: number;
  bassConfidence: number;
  otherConfidence: number;
  overallQuality: number;
}

export type StemStorageMode = 'persistent' | 'temporary' | 'disabled';

export interface AudioInput {
  trackId: string;
  filePath: string;
  duration?: number;
  contentHash?: string;
  title?: string;
}

export interface StemSeparationOptions {
  model?: string;
  provider?: string;
  quality?: 'fast' | 'balanced' | 'high';
  storageMode?: StemStorageMode;
  force?: boolean;
}

export interface StemSeparationResult {
  id: string;
  trackId: string;
  provider: string;
  modelName: string;
  modelVersion: string;
  stems: CanonicalStemSet;
  duration: number;
  sampleRate: number;
  channels: number;
  quality: StemQualityScore;
  storageMode: StemStorageMode;
  separationTimeMs: number;
  cached: boolean;
  createdAt: Date;
  expiresAt?: Date | null;
}

export interface ProviderCapabilities {
  name: string;
  available: boolean;
  supportedModels: string[];
  computeBackend: 'cuda' | 'cpu' | 'mps' | 'directml';
  supports4Stems: boolean;
  realTimeFactorEstimate: number;
  statusExplanation: string;
}

/**
 * Provider-agnostic interface for stem separation backends (Demucs, Spleeter, etc.)
 */
export interface StemSeparationProvider {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  supports(input: AudioInput): boolean;
  separate(
    input: AudioInput,
    options?: StemSeparationOptions,
  ): Promise<StemSeparationResult>;
  getCapabilities(): Promise<ProviderCapabilities>;
}

export interface VocalActivityPoint {
  t: number; // seconds
  v: number; // normalized vocal activity [0.0, 1.0]
}

export interface VocalCues {
  vocalStartSeconds: number | null;
  vocalEndSeconds: number | null;
  vocalIntensity: number;
  confidence: number;
}

export interface InstrumentalCues {
  outroStartSeconds: number | null;
  outroEndSeconds: number | null;
  instrumentalIntensity: number;
  confidence: number;
}

export interface TrackVocalFeatures {
  trackId: string;
  featureVersion: number;
  meanVocalActivity: number;
  vocalEnvelope: VocalActivityPoint[];
  vocalCues: VocalCues;
  instrumentalCues: InstrumentalCues;
  analysisStatus: 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED';
  errorMessage?: string | null;
}

export type VocalClashRisk = 'LOW' | 'MODERATE' | 'HIGH';

export interface VocalClashResult {
  clashScore: number; // 0.0 to 1.0
  clashRisk: VocalClashRisk;
  overlapDurationSeconds: number;
  overlapWindow: { start: number; end: number } | null;
  outgoingVocalActivity: number;
  incomingVocalActivity: number;
  recommendedStrategy: LayeredTransitionStrategy;
  explanation: string;
}

export type LayeredTransitionStrategy =
  | 'FULL_MIX'
  | 'VOCAL_DUCK'
  | 'INSTRUMENTAL_OUTRO_TO_VOCAL_INTRO'
  | 'ACAPELLA_BRIDGE'
  | 'NORMAL_CROSSFADE'
  | 'HARD_TRANSITION';

export interface DuckingEnvelope {
  attackSec: number;
  holdSec: number;
  releaseSec: number;
  duckDb: number;
}

export interface LayeredTransitionPlan {
  id: string;
  guildId: string;
  fromTrackId: string;
  toTrackId: string;
  strategy: LayeredTransitionStrategy;
  vocalClashScore: number;
  vocalDuckDb: number;
  duckingEnvelope?: DuckingEnvelope;
  stemsAvailable: boolean;
  outgoingStems?: CanonicalStemSet;
  incomingStems?: CanonicalStemSet;
  basePlan: TransitionPlan;
  explanation: string;
}

export interface GuildStemSettings {
  guildId: string;
  stemSeparationEnabled: boolean;
  vocalClashPrevention: boolean;
  vocalDucking: boolean;
  vocalDuckDb: number; // e.g. 6.0 dB
  layeredTransitions: boolean;
  stemProviderPreference: string; // 'auto', 'demucs', 'spleeter'
}
