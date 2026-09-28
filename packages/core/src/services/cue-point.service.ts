import type {
  CuePointSelection,
  CueStrategy,
  TrackTransitionFeatures,
  TransitionProfileConfig,
} from '../types/transition';
import { createLogger } from '../utils/logger';

const logger = createLogger('cue-point-service');

export interface CuePointOptions {
  outgoingDuration: number;
  incomingDuration: number;
  requestedDurationSeconds?: number;
  profileConfig: TransitionProfileConfig;
  outgoingFeatures?: TrackTransitionFeatures | null;
  incomingFeatures?: TrackTransitionFeatures | null;
}

export class CuePointService {
  /**
   * Intelligently select outgoing and incoming cue points based on:
   * - Beat grid and phrase boundaries (4, 8, 16, 32 beats)
   * - Intro and outro sections
   * - Energy and structure confidence
   * - Available audio material (preventing over-crossfading short tracks)
   */
  selectCuePoints(options: CuePointOptions): CuePointSelection {
    const {
      outgoingDuration,
      incomingDuration,
      requestedDurationSeconds,
      profileConfig,
      outgoingFeatures,
      incomingFeatures,
    } = options;

    // 1. Determine base target duration clamped to [1, 8] seconds
    const profileDuration = profileConfig.defaultDurationSeconds;
    let targetDuration = requestedDurationSeconds ?? profileDuration;
    targetDuration = Math.max(1, Math.min(8, targetDuration));

    // 2. Safe Dynamic Bounding: Never crossfade longer than available material
    // Maximum transition is at most 35% of track duration or 8s, whichever is smaller
    const maxOutgoingAvailable = Math.max(1, outgoingDuration * 0.35);
    const maxIncomingAvailable = Math.max(1, incomingDuration * 0.35);
    const safeMaxDuration = Math.min(targetDuration, maxOutgoingAvailable, maxIncomingAvailable);
    const finalDuration = Math.max(1, Math.round(safeMaxDuration * 10) / 10);

    const outgoingConfidence = outgoingFeatures?.beatConfidence ?? 0;
    const incomingConfidence = incomingFeatures?.beatConfidence ?? 0;
    const outgoingGrid = outgoingFeatures?.beatGrid ?? [];
    const incomingGrid = incomingFeatures?.beatGrid ?? [];

    // Fallback default: end of outgoing minus duration, start of incoming at 0.0
    const fallbackOutgoing = Math.max(0, outgoingDuration - finalDuration);
    const fallbackIncoming = 0.0;

    // If beat data is missing or low confidence, fallback gracefully
    if (outgoingConfidence < 0.5 || outgoingGrid.length < 8) {
      return {
        outgoingCueSeconds: Math.round(fallbackOutgoing * 100) / 100,
        incomingCueSeconds: fallbackIncoming,
        durationSeconds: finalDuration,
        alignedToBeat: false,
        phraseMatched: false,
        strategy: 'DURATION_FALLBACK',
        score: 0.5,
        explanation: `Duration fallback: low beat confidence (${outgoingConfidence.toFixed(2)}) or sparse beat grid`,
      };
    }

    // 3. Find Outgoing Cue Point Snap
    // We want the crossfade to start at a phrase or beat boundary such that:
    // outgoingCue + finalDuration <= outgoingDuration
    const targetOutStart = outgoingFeatures?.outroStart && outgoingFeatures.outroStart < outgoingDuration - finalDuration
      ? outgoingFeatures.outroStart
      : outgoingDuration - finalDuration;

    // Check phrase boundaries in order of preference (16-beat > 8-beat > 4-beat > beat grid)
    const boundaries = outgoingFeatures?.phraseBoundaries;
    let selectedOutCue = fallbackOutgoing;
    let phraseMatched = false;
    let alignedToBeat = false;
    let strategy: CueStrategy = 'DURATION_FALLBACK';

    const candidatePhrases = [
      ...(boundaries?.sixteenBeats ?? []),
      ...(boundaries?.eightBeats ?? []),
      ...(boundaries?.fourBeats ?? []),
    ].filter((t) => t <= outgoingDuration - finalDuration && t >= outgoingDuration * 0.5);

    if (candidatePhrases.length > 0) {
      // Find closest phrase boundary to targetOutStart
      candidatePhrases.sort((a, b) => Math.abs(a - targetOutStart) - Math.abs(b - targetOutStart));
      selectedOutCue = candidatePhrases[0];
      phraseMatched = true;
      alignedToBeat = true;
      strategy = 'PHRASE_ALIGNED';
    } else {
      // Snap to nearest beat boundary
      const eligibleBeats = outgoingGrid.filter(
        (t) => t <= outgoingDuration - finalDuration && t >= outgoingDuration * 0.6,
      );
      if (eligibleBeats.length > 0) {
        eligibleBeats.sort((a, b) => Math.abs(a - targetOutStart) - Math.abs(b - targetOutStart));
        selectedOutCue = eligibleBeats[0];
        alignedToBeat = true;
        strategy = 'BEAT_ALIGNED';
      }
    }

    // 4. Find Incoming Cue Point Snap
    let selectedInCue = 0.0;
    if (incomingConfidence >= 0.5 && incomingGrid.length > 0) {
      // If incoming track has a clean beat close to 0 (within first 0.5s), snap to it
      const firstBeat = incomingGrid.find((t) => t >= 0 && t <= 0.8);
      if (firstBeat !== undefined) {
        selectedInCue = firstBeat;
      }
    }

    // 5. Outro / Intro Quality Scoring
    const outroEnergy = outgoingFeatures?.outroEnergy ?? 0.5;
    const introEnergy = incomingFeatures?.introEnergy ?? 0.5;
    const energyCompatibility = 1.0 - Math.min(1.0, Math.abs(outroEnergy - introEnergy));

    const phraseScore = phraseMatched ? 0.35 : alignedToBeat ? 0.2 : 0.1;
    const confidenceScore = (outgoingConfidence + incomingConfidence) * 0.15;
    const energyScore = energyCompatibility * 0.2;
    const outroQuality = Math.min(1.0, (outgoingFeatures?.structureConfidence ?? 0.5)) * 0.15;

    const totalScore = Math.min(1.0, Math.round((phraseScore + confidenceScore + energyScore + outroQuality) * 100) / 100);

    return {
      outgoingCueSeconds: Math.round(selectedOutCue * 100) / 100,
      incomingCueSeconds: Math.round(selectedInCue * 100) / 100,
      durationSeconds: finalDuration,
      alignedToBeat,
      phraseMatched,
      strategy,
      score: totalScore,
      explanation: `Strategy: ${strategy} (out: ${selectedOutCue.toFixed(2)}s, in: ${selectedInCue.toFixed(2)}s, duration: ${finalDuration.toFixed(1)}s, score: ${totalScore.toFixed(2)})`,
    };
  }
}
