/**
 * Phase 9: Layered Transition Engine
 *
 * Implements requirements 15, 19, 20, 21, 24, 25, 26:
 * - Deterministic decision tree evaluating stem availability, quality, and vocal clash
 * - Produces LayeredTransitionPlan with stem-specific gain allocations
 * - Selects strategy: FULL_MIX, VOCAL_DUCK, INSTRUMENTAL_OUTRO_TO_VOCAL_INTRO, ACAPELLA_BRIDGE, NORMAL_CROSSFADE, HARD_TRANSITION
 * - Preserves outgoing drums/bass/other when ducking vocals
 * - Integrates with TransitionEngine (Phase 8 base plan)
 */

import { randomUUID } from 'node:crypto';
import type {
  CanonicalStemSet,
  GuildStemSettings,
  LayeredTransitionPlan,
  LayeredTransitionStrategy,
  StemQualityScore,
  TrackVocalFeatures,
} from '../types/stem';
import type { TransitionPlan } from '../types/transition';
import { VocalClashService } from './vocal-clash.service';
import { createLogger } from '../utils/logger';

const logger = createLogger('layered-transition-engine');

export interface LayeredTransitionInput {
  guildId: string;
  fromTrackId: string;
  toTrackId: string;
  basePlan: TransitionPlan;
  outgoingVocalFeatures?: TrackVocalFeatures | null;
  incomingVocalFeatures?: TrackVocalFeatures | null;
  outgoingStems?: CanonicalStemSet | null;
  incomingStems?: CanonicalStemSet | null;
  outgoingStemQuality?: StemQualityScore | null;
  incomingStemQuality?: StemQualityScore | null;
  guildSettings?: Partial<GuildStemSettings> | null;
  duckDbOverride?: number;
}

export class LayeredTransitionEngine {
  private readonly clashService = new VocalClashService();

  /**
   * Plan a layered stem-aware transition or gracefully fall back to Phase 8 base transition
   */
  public planTransition(input: LayeredTransitionInput): LayeredTransitionPlan {
    const {
      guildId,
      fromTrackId,
      toTrackId,
      basePlan,
      outgoingVocalFeatures,
      incomingVocalFeatures,
      outgoingStems,
      incomingStems,
      outgoingStemQuality,
      incomingStemQuality,
      guildSettings,
      duckDbOverride,
    } = input;

    const stemSeparationEnabled = guildSettings?.stemSeparationEnabled ?? true;
    const vocalClashPrevention = guildSettings?.vocalClashPrevention ?? true;
    const vocalDuckingEnabled = guildSettings?.vocalDucking ?? true;
    const layeredTransitionsEnabled = guildSettings?.layeredTransitions ?? true;
    const targetDuckDb = duckDbOverride ?? guildSettings?.vocalDuckDb ?? 6.0;

    // 1. Verify stem availability and quality threshold
    const hasStems = Boolean(
      outgoingStems?.vocals &&
      outgoingStems?.drums &&
      outgoingStems?.bass &&
      outgoingStems?.other &&
      incomingStems?.vocals &&
      incomingStems?.drums &&
      incomingStems?.bass &&
      incomingStems?.other,
    );

    const outQuality = outgoingStemQuality?.overallQuality ?? 0.8;
    const inQuality = incomingStemQuality?.overallQuality ?? 0.8;
    const isQualitySufficient = outQuality >= 0.5 && inQuality >= 0.5;

    // If stems are disabled, missing, or poor quality -> Safe Phase 8 fallback
    if (!stemSeparationEnabled || !layeredTransitionsEnabled || !hasStems || !isQualitySufficient) {
      const reason = !stemSeparationEnabled
        ? 'Stem separation disabled in guild settings'
        : !layeredTransitionsEnabled
        ? 'Layered transitions disabled in guild settings'
        : !hasStems
        ? 'Stems not yet available for both tracks (asynchronous analysis in progress)'
        : 'Stem quality confidence below acceptable threshold';

      return {
        id: randomUUID(),
        guildId,
        fromTrackId,
        toTrackId,
        strategy: 'NORMAL_CROSSFADE',
        vocalClashScore: 0.0,
        vocalDuckDb: 0.0,
        stemsAvailable: false,
        basePlan,
        explanation: `${reason}. Falling back to Phase 8 intelligent crossfade.`,
      };
    }

    // 2. Perform Vocal Clash Analysis over the transition window
    const clashResult = this.clashService.analyzeClash({
      outgoingFeatures: outgoingVocalFeatures ?? null,
      incomingFeatures: incomingVocalFeatures ?? null,
      outgoingCueSeconds: basePlan.outgoingCueSeconds,
      incomingCueSeconds: basePlan.incomingCueSeconds,
      transitionDurationSeconds: basePlan.durationSeconds,
    });

    // 3. Proactive cue-boundary detection: when stems are available and the outgoing
    // track is in its instrumental outro while the incoming has an early vocal, use
    // INSTRUMENTAL_OUTRO_TO_VOCAL_INTRO regardless of clash risk — layering the incoming
    // vocal over the outgoing instrumental bed produces a musically superior transition.
    const outOutro = outgoingVocalFeatures?.instrumentalCues?.outroStartSeconds;
    const inVocalStart = incomingVocalFeatures?.vocalCues?.vocalStartSeconds;
    const outgoingIsInOutro =
      outOutro !== null && outOutro !== undefined && basePlan.outgoingCueSeconds >= outOutro - 2.0;
    const incomingHasVocalIntro =
      inVocalStart !== null && inVocalStart !== undefined && inVocalStart <= 6.0;

    // 4. Determine Strategy & Ducking Amount
    let strategy: LayeredTransitionStrategy = clashResult.recommendedStrategy;
    let duckDb = 0.0;

    if (!vocalClashPrevention) {
      strategy = 'FULL_MIX';
      duckDb = 0.0;
    } else if (outgoingIsInOutro && incomingHasVocalIntro && layeredTransitionsEnabled) {
      // Override: proactively layer even when clash is low — outgoing instrumental
      // bed under incoming vocal intro produces the smoothest possible transition
      strategy = 'INSTRUMENTAL_OUTRO_TO_VOCAL_INTRO';
      duckDb = targetDuckDb;
    } else if (strategy === 'VOCAL_DUCK') {
      if (!vocalDuckingEnabled) {
        strategy = 'NORMAL_CROSSFADE';
        duckDb = 0.0;
      } else {
        // Scale ducking by clash intensity if moderate vs high
        duckDb = clashResult.clashRisk === 'HIGH' ? targetDuckDb : Math.max(3.0, targetDuckDb * 0.7);
      }
    } else if (strategy === 'INSTRUMENTAL_OUTRO_TO_VOCAL_INTRO') {
      // Outgoing vocals are rapidly faded while instrumental continues at unity gain
      duckDb = targetDuckDb;
    }

    const duration = basePlan.durationSeconds;
    const attackSec = Math.min(1.0, duration * 0.2);
    const releaseSec = Math.min(1.0, duration * 0.2);
    const holdSec = Math.max(0.5, duration - attackSec - releaseSec);

    logger.info(
      {
        guildId,
        strategy,
        clashScore: clashResult.clashScore,
        clashRisk: clashResult.clashRisk,
        duckDb,
      },
      'Layered transition planned',
    );

    return {
      id: randomUUID(),
      guildId,
      fromTrackId,
      toTrackId,
      strategy,
      vocalClashScore: clashResult.clashScore,
      vocalDuckDb: Math.round(duckDb * 10) / 10,
      duckingEnvelope:
        duckDb > 0
          ? {
              attackSec: Math.round(attackSec * 10) / 10,
              holdSec: Math.round(holdSec * 10) / 10,
              releaseSec: Math.round(releaseSec * 10) / 10,
              duckDb: Math.round(duckDb * 10) / 10,
            }
          : undefined,
      stemsAvailable: true,
      outgoingStems: outgoingStems!,
      incomingStems: incomingStems!,
      basePlan,
      explanation: clashResult.explanation,
    };
  }
}
