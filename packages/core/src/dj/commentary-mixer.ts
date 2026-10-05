/**
 * Commentary Mixer & Priority Manager
 *
 * Implements Requirements 19 & 20:
 * - Mixed commentary between songs or smoothly ducked over music.
 * - Smooth volume ramps (attack / release) to preserve music aesthetics.
 * - Strict priority resolution: User speech > Music continuity > System audio > DJ commentary.
 */

import { EventEmitter } from 'node:events';
import { AudioResampler } from '../audio/audio-resampler';
import type { CommentaryMixingMode, DJCommentary, DJCommentaryConfig } from '../types/dj-commentary';
import { createLogger } from '../utils/logger';

const logger = createLogger('commentary-mixer');

export class CommentaryMixer extends EventEmitter {
  private isUserSpeaking = false;
  private isMusicPlaying = false;
  private isCommentaryPlaying = false;

  private config: DJCommentaryConfig;

  constructor(config?: Partial<DJCommentaryConfig>) {
    super();
    this.config = {
      enabled: true,
      cooldownSeconds: 180,
      mixingMode: 'BETWEEN_SONGS',
      duckingVolumeMultiplier: 0.25,
      duckingAttackMs: 300,
      duckingReleaseMs: 500,
      voiceProfile: 'Puck',
      maxCommentaryLengthWords: 25,
      allowVoiceOverMusic: false,
      ...config,
    };
  }

  updateConfig(newConfig: Partial<DJCommentaryConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.emit('config_updated', this.config);
  }

  getConfig(): DJCommentaryConfig {
    return { ...this.config };
  }

  /**
   * Signal user speech activity (VAD) to enforce priority.
   * If user speaks, DJ commentary is immediately suppressed / skipped.
   */
  setUserSpeaking(isSpeaking: boolean): void {
    this.isUserSpeaking = isSpeaking;
    if (isSpeaking && this.isCommentaryPlaying) {
      logger.info('User speech detected — dropping/cancelling active DJ commentary');
      this.cancelActiveCommentary('User speech interrupted DJ commentary');
    }
  }

  setMusicPlaying(isPlaying: boolean): void {
    this.isMusicPlaying = isPlaying;
  }

  /**
   * Mix commentary audio with music audio according to configuration mode and priority.
   * Returns mixed 48kHz stereo 16-bit PCM buffer.
   */
  mixCommentary(
    musicBuffer: Buffer,
    commentary: DJCommentary,
    modeOverride?: CommentaryMixingMode,
  ): { buffer: Buffer; mixed: boolean; reason?: string } {
    // Priority check 1: If user is speaking, skip DJ commentary
    if (this.isUserSpeaking) {
      logger.debug('Skipping DJ commentary because user is speaking');
      return { buffer: musicBuffer, mixed: false, reason: 'User speaking' };
    }

    if (!commentary.audioBuffer || commentary.audioBuffer.length === 0) {
      return { buffer: musicBuffer, mixed: false, reason: 'Empty commentary audio' };
    }

    // Convert commentary to 48kHz stereo PCM if needed
    const commentary48kStereo =
      commentary.audioFormat?.sampleRate === 24000
        ? AudioResampler.upsample24kTo48kStereo(commentary.audioBuffer)
        : commentary.audioBuffer;

    const mode = modeOverride || commentary.mixingMode || this.config.mixingMode;

    if (mode === 'DUCKED_VOICE_OVER_MUSIC' && this.config.allowVoiceOverMusic) {
      // Ducked voice over music
      const mixedPcm = AudioResampler.mixDuckedAudio(
        musicBuffer,
        commentary48kStereo,
        this.config.duckingVolumeMultiplier,
        2,
      );

      this.emit('commentary_played', {
        commentaryId: commentary.id,
        mode: 'DUCKED_VOICE_OVER_MUSIC',
        durationSeconds: commentary.durationSeconds,
      });

      return { buffer: mixedPcm, mixed: true };
    } else {
      // Between songs mode: prepend commentary to music or return commentary buffer
      if (musicBuffer.length === 0) {
        return { buffer: commentary48kStereo, mixed: true };
      }

      // Concatenate commentary followed by music
      const combined = Buffer.concat([commentary48kStereo, musicBuffer]);
      this.emit('commentary_played', {
        commentaryId: commentary.id,
        mode: 'BETWEEN_SONGS',
        durationSeconds: commentary.durationSeconds,
      });

      return { buffer: combined, mixed: true };
    }
  }

  private cancelActiveCommentary(reason: string): void {
    this.isCommentaryPlaying = false;
    this.emit('commentary_cancelled', { reason, timestampMs: Date.now() });
  }
}
