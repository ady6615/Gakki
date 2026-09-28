/**
 * Phase 9: Vocal Clash Detection & Analysis Service
 *
 * Implements requirement 11, 14, 15:
 * - Detects vocal overlap windows between Outgoing (Track A) and Incoming (Track B)
 * - Computes normalized clashScore in [0.0, 1.0]
 * - Categorizes risk: LOW (0.0-0.3), MODERATE (0.3-0.6), HIGH (0.6-1.0)
 * - Recommends optimal layered transition strategy
 */

import type {
  TrackVocalFeatures,
  VocalClashResult,
  VocalClashRisk,
  LayeredTransitionStrategy,
} from '../types/stem';
import { VocalActivityService } from './vocal-activity.service';
import { createLogger } from '../utils/logger';

const logger = createLogger('vocal-clash-service');

export interface ClashAnalysisOptions {
  outgoingFeatures: TrackVocalFeatures | null;
  incomingFeatures: TrackVocalFeatures | null;
  outgoingCueSeconds: number; // When transition begins in Track A
  incomingCueSeconds: number; // When transition begins in Track B (usually 0.0)
  transitionDurationSeconds: number;
  lowThreshold?: number; // default 0.3
  highThreshold?: number; // default 0.6
}

export class VocalClashService {
  private readonly activityService = new VocalActivityService();

  /**
   * Analyze prospective vocal clash between two tracks over the transition window
   */
  public analyzeClash(options: ClashAnalysisOptions): VocalClashResult {
    const {
      outgoingFeatures,
      incomingFeatures,
      outgoingCueSeconds,
      incomingCueSeconds,
      transitionDurationSeconds,
      lowThreshold = 0.3,
      highThreshold = 0.6,
    } = options;

    // If features are unavailable or missing envelopes, return safe fallback
    if (!outgoingFeatures || !incomingFeatures) {
      return {
        clashScore: 0.0,
        clashRisk: 'LOW',
        overlapDurationSeconds: 0,
        overlapWindow: null,
        outgoingVocalActivity: 0.0,
        incomingVocalActivity: 0.0,
        recommendedStrategy: 'NORMAL_CROSSFADE',
        explanation: 'Vocal features unavailable; default to standard crossfade',
      };
    }

    const duration = Math.max(0.5, transitionDurationSeconds);
    const stepSize = 0.1; // 100ms sampling
    const steps = Math.floor(duration / stepSize);

    let simultaneousVocalDuration = 0;
    let sumClashProduct = 0;
    let sumOutVocal = 0;
    let sumInVocal = 0;
    let firstOverlapTime: number | null = null;
    let lastOverlapTime: number | null = null;

    for (let i = 0; i <= steps; i++) {
      const offset = i * stepSize;
      const tOut = outgoingCueSeconds + offset;
      const tIn = incomingCueSeconds + offset;

      const vOut = this.activityService.getVocalActivityAt(outgoingFeatures, tOut);
      const vIn = this.activityService.getVocalActivityAt(incomingFeatures, tIn);

      sumOutVocal += vOut;
      sumInVocal += vIn;

      const product = vOut * vIn;
      sumClashProduct += product;

      // Both tracks active if vocal activity > 0.18
      if (vOut >= 0.18 && vIn >= 0.18) {
        simultaneousVocalDuration += stepSize;
        if (firstOverlapTime === null) {
          firstOverlapTime = offset;
        }
        lastOverlapTime = offset;
      }
    }

    const count = steps + 1;
    const avgOutVocal = count > 0 ? sumOutVocal / count : 0.0;
    const avgInVocal = count > 0 ? sumInVocal / count : 0.0;
    const meanProduct = count > 0 ? sumClashProduct / count : 0.0;

    // Weight combination: overlap duration proportion + mean product intensity
    const durationRatio = Math.min(1.0, simultaneousVocalDuration / duration);
    const rawScore = meanProduct * 0.6 + durationRatio * 0.4;
    const clashScore = Math.min(1.0, Math.max(0.0, Math.round(rawScore * 100) / 100));

    // Classify risk
    let clashRisk: VocalClashRisk = 'LOW';
    if (clashScore >= highThreshold) {
      clashRisk = 'HIGH';
    } else if (clashScore >= lowThreshold) {
      clashRisk = 'MODERATE';
    }

    // Determine strategy recommendation based on clash & cues
    const { recommendedStrategy, explanation } = this.determineStrategy({
      clashRisk,
      clashScore,
      outgoingFeatures,
      incomingFeatures,
      outgoingCueSeconds,
      incomingCueSeconds,
      duration,
    });

    return {
      clashScore,
      clashRisk,
      overlapDurationSeconds: Math.round(simultaneousVocalDuration * 10) / 10,
      overlapWindow:
        firstOverlapTime !== null && lastOverlapTime !== null
          ? {
              start: Math.round(firstOverlapTime * 10) / 10,
              end: Math.round(lastOverlapTime * 10) / 10,
            }
          : null,
      outgoingVocalActivity: Math.round(avgOutVocal * 100) / 100,
      incomingVocalActivity: Math.round(avgInVocal * 100) / 100,
      recommendedStrategy,
      explanation,
    };
  }

  private determineStrategy(ctx: {
    clashRisk: VocalClashRisk;
    clashScore: number;
    outgoingFeatures: TrackVocalFeatures;
    incomingFeatures: TrackVocalFeatures;
    outgoingCueSeconds: number;
    incomingCueSeconds: number;
    duration: number;
  }): { recommendedStrategy: LayeredTransitionStrategy; explanation: string } {
    const { clashRisk, clashScore, outgoingFeatures, incomingFeatures, outgoingCueSeconds } = ctx;

    const outOutro = outgoingFeatures.instrumentalCues?.outroStartSeconds;
    const inVocalStart = incomingFeatures.vocalCues?.vocalStartSeconds;

    // Check if Outgoing is in a clean instrumental section and Incoming has an early vocal
    const outgoingIsInstrumental =
      outOutro !== null && outOutro !== undefined && outgoingCueSeconds >= outOutro - 2.0;
    const incomingHasVocalIntro =
      inVocalStart !== null && inVocalStart !== undefined && inVocalStart <= 6.0;

    if (clashRisk === 'HIGH') {
      if (outgoingIsInstrumental && incomingHasVocalIntro) {
        return {
          recommendedStrategy: 'INSTRUMENTAL_OUTRO_TO_VOCAL_INTRO',
          explanation: `High vocal clash risk (${clashScore.toFixed(2)}). Outgoing track is in instrumental outro and incoming track has vocal intro: executing layered transition.`,
        };
      }
      return {
        recommendedStrategy: 'VOCAL_DUCK',
        explanation: `High vocal clash risk (${clashScore.toFixed(2)}). Applying stem vocal ducking on outgoing vocals to avoid clash while preserving instrumental rhythm.`,
      };
    }

    if (clashRisk === 'MODERATE') {
      if (incomingHasVocalIntro && outgoingIsInstrumental) {
        return {
          recommendedStrategy: 'INSTRUMENTAL_OUTRO_TO_VOCAL_INTRO',
          explanation: `Moderate vocal clash (${clashScore.toFixed(2)}) with compatible cues. Layering incoming vocal over outgoing instrumental.`,
        };
      }
      return {
        recommendedStrategy: 'VOCAL_DUCK',
        explanation: `Moderate vocal clash risk (${clashScore.toFixed(2)}). Applying moderate vocal ducking on outgoing vocals.`,
      };
    }

    // LOW clash
    return {
      recommendedStrategy: 'NORMAL_CROSSFADE',
      explanation: `Low vocal clash risk (${clashScore.toFixed(2)}). Standard stem-aware crossfade is safe and musical.`,
    };
  }
}
