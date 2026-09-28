import * as crypto from 'node:crypto';
import type {
  FallbackLevel,
  GuildTransitionSettings,
  KeyCompatibilityResult,
  TrackTransitionFeatures,
  TransitionPlan,
  TransitionProfile,
} from '../types/transition';
import { TRANSITION_PROFILES } from '../types/transition';
import { KeyCompatibilityService } from './key-compatibility.service';
import { CuePointService } from './cue-point.service';
import { createLogger } from '../utils/logger';

const logger = createLogger('transition-engine');

export interface TransitionRequest {
  guildId: string;
  fromTrackId: string;
  toTrackId: string;
  fromTrackDuration: number;
  toTrackDuration: number;
  fromTrackBpm?: number | null;
  toTrackBpm?: number | null;
  fromFeatures?: TrackTransitionFeatures | null;
  toFeatures?: TrackTransitionFeatures | null;
  settings?: Partial<GuildTransitionSettings>;
  rubberBandAvailable?: boolean;
  isFromSeekable?: boolean;
  isToSeekable?: boolean;
}

export class TransitionEngine {
  private readonly keyService = new KeyCompatibilityService();
  private readonly cueService = new CuePointService();

  /**
   * Evaluate whether a transition is possible and compute the optimal TransitionPlan.
   *
   * Pure, deterministic, independent of Discord audio playback threads.
   */
  planTransition(request: TransitionRequest): TransitionPlan {
    const {
      guildId,
      fromTrackId,
      toTrackId,
      fromTrackDuration,
      toTrackDuration,
      fromTrackBpm,
      toTrackBpm,
      fromFeatures,
      toFeatures,
      settings,
      rubberBandAvailable = false,
      isFromSeekable = true,
      isToSeekable = true,
    } = request;

    const profileName: TransitionProfile = settings?.transitionProfile ?? 'BALANCED';
    const profileConfig = TRANSITION_PROFILES[profileName] || TRANSITION_PROFILES.BALANCED;
    const isTransitionEnabled = settings?.transitionEnabled ?? true;

    // Check if transition is explicitly disabled
    if (!isTransitionEnabled) {
      return this.createHardCutPlan(
        guildId,
        fromTrackId,
        toTrackId,
        profileName,
        fromTrackDuration,
        'Transitions disabled by guild settings',
      );
    }

    // Check for non-seekable streams or very short tracks (< 5 seconds)
    if (fromTrackDuration < 5 || toTrackDuration < 5) {
      return this.createHardCutPlan(
        guildId,
        fromTrackId,
        toTrackId,
        profileName,
        fromTrackDuration,
        'Track duration too short for crossfading (< 5s)',
      );
    }

    // 1. Cue Points Selection
    const requestedDuration = settings?.transitionDuration ?? profileConfig.defaultDurationSeconds;
    const cueSelection = this.cueService.selectCuePoints({
      outgoingDuration: fromTrackDuration,
      incomingDuration: toTrackDuration,
      requestedDurationSeconds: requestedDuration,
      profileConfig,
      outgoingFeatures: fromFeatures,
      incomingFeatures: toFeatures,
    });

    // 2. Harmonic Compatibility & Micro Pitch Shift
    const harmonicMixingEnabled = settings?.harmonicMixing ?? true;
    const outgoingKey = fromFeatures?.key ?? null;
    const incomingKey = toFeatures?.key ?? null;
    const incomingKeyConfidence = toFeatures?.keyConfidence ?? 0.7;

    let keyResult: KeyCompatibilityResult;
    if (harmonicMixingEnabled) {
      keyResult = this.keyService.evaluate(
        outgoingKey,
        incomingKey,
        incomingKeyConfidence,
        rubberBandAvailable,
      );
    } else {
      keyResult = {
        outgoingKey: outgoingKey ?? 'Unknown',
        incomingKey: incomingKey ?? 'Unknown',
        outgoingCamelot: fromFeatures?.camelotCode ?? '8B',
        incomingCamelot: toFeatures?.camelotCode ?? '8B',
        relationship: 'SAME_KEY',
        compatibilityScore: 1.0,
        pitchShiftSemitones: 0,
        shiftApplied: false,
        explanation: 'Harmonic mixing disabled by settings',
      };
    }

    // 3. Tempo Adjustment Calculation
    const autoTempoEnabled = settings?.autoTempo ?? true;
    let tempoAdjustmentPercent = 0;

    const bpmOut = fromTrackBpm ?? (fromFeatures?.beatGrid && fromFeatures.beatGrid.length >= 2 ? (60 / (fromFeatures.beatGrid[1] - fromFeatures.beatGrid[0])) : null);
    const bpmIn = toTrackBpm ?? (toFeatures?.beatGrid && toFeatures.beatGrid.length >= 2 ? (60 / (toFeatures.beatGrid[1] - toFeatures.beatGrid[0])) : null);

    if (
      autoTempoEnabled &&
      rubberBandAvailable &&
      bpmOut &&
      bpmIn &&
      bpmOut > 40 &&
      bpmIn > 40
    ) {
      const rawDeltaPercent = ((bpmIn - bpmOut) / bpmOut) * 100;
      if (Math.abs(rawDeltaPercent) <= profileConfig.maxTempoAdjustmentPercent) {
        tempoAdjustmentPercent = Math.round(rawDeltaPercent * 100) / 100;
      }
    }

    // 4. Loudness Normalization
    const loudnessNormalizeEnabled = settings?.loudnessNormalize ?? true;
    let fromTrackGainDb = 0;
    let toTrackGainDb = 0;

    if (loudnessNormalizeEnabled) {
      fromTrackGainDb = fromFeatures?.trackGainDb ?? 0;
      toTrackGainDb = toFeatures?.trackGainDb ?? 0;
      // Cap maximum adjustment to ±14 dB to prevent extreme amplification or attenuation
      fromTrackGainDb = Math.min(14.0, Math.max(-14.0, fromTrackGainDb));
      toTrackGainDb = Math.min(14.0, Math.max(-14.0, toTrackGainDb));
    }

    // 5. Determine Fallback Level Ladder
    let fallbackLevel: FallbackLevel = 'ADVANCED';
    if (!isFromSeekable || !isToSeekable) {
      fallbackLevel = 'SIMPLE_FADE';
    } else if (!rubberBandAvailable || (tempoAdjustmentPercent === 0 && keyResult.pitchShiftSemitones === 0)) {
      fallbackLevel = 'CROSSFADE';
    }

    // 6. Overall Transition Score
    const transitionScore = Math.min(
      1.0,
      Math.round(
        (cueSelection.score * 0.45 +
          keyResult.compatibilityScore * 0.35 +
          (tempoAdjustmentPercent !== 0 ? 0.2 : 0.1)) *
          100,
      ) / 100,
    );

    const planId = crypto.randomUUID();
    const explanation = `[v1:${fallbackLevel}] ${profileName} (${cueSelection.durationSeconds}s, ${profileConfig.curve}): ${cueSelection.explanation}. Key: ${keyResult.explanation}. Tempo adj: ${tempoAdjustmentPercent > 0 ? '+' : ''}${tempoAdjustmentPercent}%`;

    logger.debug({ planId, guildId, fallbackLevel, score: transitionScore }, explanation);

    return {
      id: planId,
      guildId,
      fromTrackId,
      toTrackId,
      profile: profileName,
      durationSeconds: cueSelection.durationSeconds,
      curve: profileConfig.curve,
      overlap: true,
      outgoingCueSeconds: cueSelection.outgoingCueSeconds,
      incomingCueSeconds: cueSelection.incomingCueSeconds,
      tempoAdjustmentPercent,
      pitchShiftSemitones: keyResult.pitchShiftSemitones,
      fromTrackGainDb,
      toTrackGainDb,
      loudnessProfileApplied: loudnessNormalizeEnabled && (fromTrackGainDb !== 0 || toTrackGainDb !== 0),
      fallbackLevel,
      algorithmVersion: 'v1',
      score: transitionScore,
      explanation,
    };
  }

  private createHardCutPlan(
    guildId: string,
    fromTrackId: string,
    toTrackId: string,
    profile: TransitionProfile,
    fromDuration: number,
    reason: string,
  ): TransitionPlan {
    return {
      id: crypto.randomUUID(),
      guildId,
      fromTrackId,
      toTrackId,
      profile,
      durationSeconds: 0,
      curve: 'tri',
      overlap: false,
      outgoingCueSeconds: Math.max(0, fromDuration),
      incomingCueSeconds: 0,
      tempoAdjustmentPercent: 0,
      pitchShiftSemitones: 0,
      fromTrackGainDb: 0,
      toTrackGainDb: 0,
      fallbackLevel: 'HARD_CUT',
      algorithmVersion: 'v1',
      score: 0.0,
      explanation: `Hard cut: ${reason}`,
    };
  }
}
