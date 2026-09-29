/**
 * Phase 9: Stem Separation Provider Interface
 *
 * Implements requirement 1:
 * Provider-agnostic interface decoupling Gakki from Demucs, Spleeter, or any specific ML backend.
 */

export type {
  StemSeparationProvider,
  ProviderCapabilities,
  StemAudioInput,
  StemSeparationOptions,
  StemSeparationResult,
  CanonicalStemSet,
  StemQualityScore,
  StemStorageMode,
} from '@gakki/core';
