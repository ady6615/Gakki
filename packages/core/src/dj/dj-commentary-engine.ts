/**
 * AI DJ Voice Commentary Engine
 *
 * Implements Requirements 14, 15, 18, 20:
 * - Independent orchestrator for AI DJ speech generation.
 * - Trigger evaluation with cooldown enforcement (e.g. 180s).
 * - Asynchronous pre-generation BEFORE track transitions to guarantee ZERO audio gaps.
 * - Multi-level priority handling.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type {
  DJCommentary,
  DJCommentaryConfig,
  DJCommentaryContext,
  DJCommentaryTrigger,
} from '../types/dj-commentary';
import { DJTextGenerator } from './dj-text-generator';
import { TTSProviderRegistry } from './tts/tts-provider.registry';
import { CommentaryMixer } from './commentary-mixer';
import { createLogger } from '../utils/logger';

const logger = createLogger('dj-commentary-engine');

export class DJCommentaryEngine extends EventEmitter {
  private readonly guildLastCommentaryTime = new Map<string, number>(); // guildId -> timestampMs
  private readonly pregeneratedCommentaries = new Map<string, DJCommentary>(); // `${guildId}:${toTrackId}` -> commentary
  private readonly mixer: CommentaryMixer;
  private readonly ttsRegistry: TTSProviderRegistry;

  constructor(
    ttsRegistry?: TTSProviderRegistry,
    mixerConfig?: Partial<DJCommentaryConfig>,
  ) {
    super();
    this.ttsRegistry = ttsRegistry || new TTSProviderRegistry();
    this.mixer = new CommentaryMixer(mixerConfig);

    this.mixer.on('commentary_played', (data) => this.emit('commentary_played', data));
    this.mixer.on('commentary_cancelled', (data) => this.emit('commentary_cancelled', data));
  }

  getMixer(): CommentaryMixer {
    return this.mixer;
  }

  getConfig(): DJCommentaryConfig {
    return this.mixer.getConfig();
  }

  updateConfig(config: Partial<DJCommentaryConfig>): void {
    this.mixer.updateConfig(config);
  }

  /**
   * Evaluates if a DJ commentary should trigger for a given context and guild.
   */
  shouldTriggerCommentary(context: DJCommentaryContext): {
    shouldTrigger: boolean;
    reason: string;
  } {
    const config = this.mixer.getConfig();
    if (!config.enabled) {
      return { shouldTrigger: false, reason: 'DJ commentary is disabled' };
    }

    // Explicit user requests and initial DJ start bypass cooldown
    if (context.trigger === 'USER_REQUEST' || context.trigger === 'DJ_START') {
      return { shouldTrigger: true, reason: `Trigger ${context.trigger} bypasses cooldown` };
    }

    const lastTime = this.guildLastCommentaryTime.get(context.guildId) || 0;
    const elapsedSeconds = (Date.now() - lastTime) / 1000;

    if (elapsedSeconds < config.cooldownSeconds) {
      return {
        shouldTrigger: false,
        reason: `Cooldown active (${Math.round(config.cooldownSeconds - elapsedSeconds)}s remaining)`,
      };
    }

    // Evaluate trigger significance
    if (
      context.trigger === 'ENERGY_TRANSITION' &&
      context.energyDelta !== undefined &&
      context.energyDelta !== null &&
      Math.abs(context.energyDelta) >= 0.2
    ) {
      return { shouldTrigger: true, reason: 'Significant energy transition detected' };
    }

    if (context.trigger === 'SPECIAL_TRANSITION') {
      return { shouldTrigger: true, reason: 'Special harmonic/beat-matched transition' };
    }

    if (context.trigger === 'PLAYLIST_START' || context.trigger === 'VIBE_PLAYLIST') {
      return { shouldTrigger: true, reason: `Playlist trigger: ${context.trigger}` };
    }

    if (context.trigger === 'TRACK_TRANSITION' || context.trigger === 'REGULAR_INTERVAL') {
      return { shouldTrigger: true, reason: 'Regular cooldown interval elapsed' };
    }

    return { shouldTrigger: false, reason: 'No qualifying trigger condition' };
  }

  /**
   * Pre-generates commentary text and TTS audio buffer asynchronously before transition starts.
   * Requirement 18: NEVER pause or delay playback waiting for TTS!
   */
  async pregenerateCommentary(
    context: DJCommentaryContext,
    providerId?: string,
  ): Promise<DJCommentary | null> {
    const triggerEval = this.shouldTriggerCommentary(context);
    if (!triggerEval.shouldTrigger) {
      logger.debug({ guildId: context.guildId, reason: triggerEval.reason }, '[TTS] Skipping commentary pre-generation');
      return null;
    }

    const config = this.mixer.getConfig();
    const commentaryText = DJTextGenerator.generateCommentaryText(context);
    const commentaryId = randomUUID();

    logger.info(
      { guildId: context.guildId, trigger: context.trigger, text: commentaryText },
      '[TTS] Commentary generated — starting asynchronous TTS synthesis',
    );

    try {
      const provider = this.ttsRegistry.getProvider(providerId);
      const ttsResult = await provider.synthesize(commentaryText, {
        voice: config.voiceProfile,
        sampleRate: 24000,
      });

      const commentary: DJCommentary = {
        id: commentaryId,
        text: commentaryText,
        trigger: context.trigger,
        voiceProfile: config.voiceProfile,
        audioBuffer: ttsResult.audioBuffer,
        audioFormat: {
          sampleRate: ttsResult.format.sampleRate,
          channels: ttsResult.format.channels,
          encoding: ttsResult.format.encoding,
        },
        durationSeconds: ttsResult.durationSeconds,
        pregeneratedAt: new Date().toISOString(),
        readyForPlayback: true,
        mixingMode: config.mixingMode,
      };

      if (context.toTrack) {
        const key = `${context.guildId}:${context.toTrack.id}`;
        this.pregeneratedCommentaries.set(key, commentary);
      }

      this.emit('commentary_pregenerated', {
        guildId: context.guildId,
        commentaryId,
        text: commentaryText,
        latencyMs: ttsResult.latencyMs,
        durationSeconds: ttsResult.durationSeconds,
      });

      return commentary;
    } catch (err) {
      logger.warn({ err, guildId: context.guildId }, '[TTS] Error pregenerating commentary TTS — skipping');
      return null;
    }
  }

  /**
   * Retrieves pre-generated commentary for a track transition and updates the guild cooldown.
   */
  consumePregeneratedCommentary(
    guildId: string,
    toTrackId: string,
  ): DJCommentary | null {
    const key = `${guildId}:${toTrackId}`;
    const commentary = this.pregeneratedCommentaries.get(key);
    if (commentary) {
      this.pregeneratedCommentaries.delete(key);
      this.guildLastCommentaryTime.set(guildId, Date.now());
      return commentary;
    }
    return null;
  }

  /**
   * Manually records that a commentary occurred for cooldown tracking.
   */
  recordCommentaryTriggered(guildId: string): void {
    this.guildLastCommentaryTime.set(guildId, Date.now());
  }

  /**
   * Clears any stale pre-generated commentaries for a guild.
   */
  clearGuildCommentaries(guildId: string): void {
    for (const key of this.pregeneratedCommentaries.keys()) {
      if (key.startsWith(`${guildId}:`)) {
        this.pregeneratedCommentaries.delete(key);
      }
    }
  }
}
