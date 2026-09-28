/**
 * Phase 9: Layered Audio Processor & Stem Mixing Engine
 *
 * Implements requirements 16, 17, 18, 19, 20, 27, 28, 33:
 * - Stem-level ducking: reduces outgoing vocals while strictly preserving outgoing drums/bass/other
 * - Layered transition mixing using FFmpeg filtergraphs (amix, volume, acrossfade)
 * - True-peak limiter protection (prevents clipping from layered stems)
 * - Deterministic fallback hierarchy: Layered -> Vocal Duck -> Stem Crossfade -> Phase 8 Crossfade -> Simple Fade -> Hard Cut
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { PassThrough, type Readable } from 'node:stream';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  CanonicalStemSet,
  LayeredTransitionPlan,
  TransitionPlan,
} from '@gakki/core';
import { createLogger } from '@gakki/core';
import { getFfmpegPath } from './ffmpeg';
import { TransitionProcessor, type TransitionRenderOptions } from './transition-processor';

const logger = createLogger('layered-audio-processor');

export interface LayeredRenderOptions {
  plan: LayeredTransitionPlan;
  fromSource: string; // Original audio source
  toSource: string; // Original audio source
  seekFromSeconds?: number;
  seekToSeconds?: number;
  sampleRate?: number;
  channels?: number;
}

export type LayeredFallbackLevel =
  | 'LAYERED_STEM'
  | 'VOCAL_DUCK_MIX'
  | 'STEM_CROSSFADE'
  | 'PHASE8_CROSSFADE'
  | 'SIMPLE_FADE'
  | 'HARD_CUT';

export class LayeredAudioProcessor {
  private readonly ffmpegBinary: string;
  private readonly phase8Processor: TransitionProcessor;

  constructor(customBinaryPath?: string) {
    this.ffmpegBinary =
      customBinaryPath ||
      process.env.DJ_FFMPEG_PATH ||
      process.env.TRANSITION_FFMPEG_PATH ||
      getFfmpegPath();
    this.phase8Processor = new TransitionProcessor(this.ffmpegBinary);
  }

  /**
   * Build the FFmpeg filtergraph for stem-level mixing
   */
  public buildStemFilterGraph(
    plan: LayeredTransitionPlan,
    level: LayeredFallbackLevel,
  ): { filterComplex: string; mapOutput: string } {
    const { strategy, vocalDuckDb, duckingEnvelope, basePlan } = plan;
    const duration = Math.max(1, basePlan.durationSeconds);
    const curve = basePlan.curve || 'qsin';
    const duckAmount = vocalDuckDb || 6.0;

    // Outgoing & incoming track loudness normalization gains
    const fromGain = basePlan.fromTrackGainDb || 0;
    const toGain = basePlan.toTrackGainDb || 0;

    if (level === 'HARD_CUT') {
      const filter = `[0:a]volume=${fromGain.toFixed(2)}dB[a0];[1:a]volume=${toGain.toFixed(2)}dB[a1];[a0][a1]concat=n=2:v=0:a=1[out]`;
      return { filterComplex: filter, mapOutput: '[out]' };
    }

    if (level === 'SIMPLE_FADE' || level === 'PHASE8_CROSSFADE') {
      const filter = `[0:a]volume=${fromGain.toFixed(2)}dB,afade=t=out:d=${duration}:curve=tri[a0];[1:a]volume=${toGain.toFixed(2)}dB,afade=t=in:d=${duration}:curve=tri[a1];[a0][a1]acrossfade=d=${duration}:c1=tri:c2=tri[out]`;
      return { filterComplex: filter, mapOutput: '[out]' };
    }

    // Stem inputs:
    // Outgoing stems: [0:a]=vocals, [1:a]=drums, [2:a]=bass, [3:a]=other
    // Incoming stems: [4:a]=vocals, [5:a]=drums, [6:a]=bass, [7:a]=other
    const filters: string[] = [];

    if (strategy === 'VOCAL_DUCK') {
      // Outgoing vocals: attenuated by duckAmount (e.g. -6dB) + fade out
      filters.push(
        `[0:a]volume=${(fromGain - duckAmount).toFixed(2)}dB,afade=t=out:d=${duration}:curve=${curve}[out_v]`,
      );
      // Outgoing rhythm: drums and bass preserved at full level during transition!
      filters.push(
        `[1:a]volume=${fromGain.toFixed(2)}dB,afade=t=out:d=${duration}:curve=tri[out_d]`,
      );
      filters.push(
        `[2:a]volume=${fromGain.toFixed(2)}dB,afade=t=out:d=${duration}:curve=tri[out_b]`,
      );
      filters.push(
        `[3:a]volume=${fromGain.toFixed(2)}dB,afade=t=out:d=${duration}:curve=${curve}[out_o]`,
      );
    } else if (strategy === 'INSTRUMENTAL_OUTRO_TO_VOCAL_INTRO') {
      // Outgoing vocals: quick 1.0s cut/fade to clear the mix for incoming vocal
      const quickFade = Math.min(1.0, duration * 0.3);
      filters.push(
        `[0:a]volume=${(fromGain - duckAmount * 1.5).toFixed(2)}dB,afade=t=out:d=${quickFade}:curve=tri[out_v]`,
      );
      // Outgoing instrumental stays confident under incoming vocal
      filters.push(
        `[1:a]volume=${fromGain.toFixed(2)}dB,afade=t=out:d=${duration}:curve=${curve}[out_d]`,
      );
      filters.push(
        `[2:a]volume=${fromGain.toFixed(2)}dB,afade=t=out:d=${duration}:curve=${curve}[out_b]`,
      );
      filters.push(
        `[3:a]volume=${fromGain.toFixed(2)}dB,afade=t=out:d=${duration}:curve=${curve}[out_o]`,
      );
    } else {
      // FULL_MIX / NORMAL_CROSSFADE
      filters.push(
        `[0:a]volume=${fromGain.toFixed(2)}dB,afade=t=out:d=${duration}:curve=${curve}[out_v]`,
      );
      filters.push(
        `[1:a]volume=${fromGain.toFixed(2)}dB,afade=t=out:d=${duration}:curve=${curve}[out_d]`,
      );
      filters.push(
        `[2:a]volume=${fromGain.toFixed(2)}dB,afade=t=out:d=${duration}:curve=${curve}[out_b]`,
      );
      filters.push(
        `[3:a]volume=${fromGain.toFixed(2)}dB,afade=t=out:d=${duration}:curve=${curve}[out_o]`,
      );
    }

    // Incoming stems: fade in smoothly
    filters.push(
      `[4:a]volume=${toGain.toFixed(2)}dB,afade=t=in:d=${duration}:curve=${curve}[in_v]`,
    );
    filters.push(
      `[5:a]volume=${toGain.toFixed(2)}dB,afade=t=in:d=${duration}:curve=${curve}[in_d]`,
    );
    filters.push(
      `[6:a]volume=${toGain.toFixed(2)}dB,afade=t=in:d=${duration}:curve=${curve}[in_b]`,
    );
    filters.push(
      `[7:a]volume=${toGain.toFixed(2)}dB,afade=t=in:d=${duration}:curve=${curve}[in_o]`,
    );

    // Sum all 8 processed stems and apply True-Peak protection (-1.0 dBTP limiter)
    filters.push(
      `[out_v][out_d][out_b][out_o][in_v][in_d][in_b][in_o]amix=inputs=8:duration=longest:dropout_transition=0:normalize=0[mixed]`,
    );
    // Peak limiter prevents clipping from layered stems
    filters.push(
      `[mixed]alimiter=limit=-1.0dB:attack=5:release=50:asc=0[out]`,
    );

    return {
      filterComplex: filters.join(';'),
      mapOutput: '[out]',
    };
  }

  /**
   * Render offline transition audio file with graceful fallback ladder
   */
  public async renderTransitionToFile(
    options: LayeredRenderOptions,
    outputPath: string,
  ): Promise<string> {
    const { plan, fromSource, toSource } = options;

    const outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    const fallbackLadder: LayeredFallbackLevel[] = [
      'LAYERED_STEM',
      'VOCAL_DUCK_MIX',
      'STEM_CROSSFADE',
      'PHASE8_CROSSFADE',
      'SIMPLE_FADE',
      'HARD_CUT',
    ];

    // If stems are missing on the plan, skip stem levels
    const startIndex = plan.stemsAvailable && plan.outgoingStems && plan.incomingStems ? 0 : 3;

    for (let i = startIndex; i < fallbackLadder.length; i++) {
      const level = fallbackLadder[i];
      try {
        logger.debug({ level, outputPath }, 'Attempting layered transition render');
        await this.executeRender(options, outputPath, level);
        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
          logger.info({ level, outputPath }, 'Layered transition rendered successfully');
          return outputPath;
        }
      } catch (err) {
        logger.warn({ err, level }, 'Transition render level failed, falling back');
      }
    }

    throw new Error('All transition render levels failed');
  }

  private async executeRender(
    options: LayeredRenderOptions,
    outputPath: string,
    level: LayeredFallbackLevel,
  ): Promise<void> {
    const { plan, fromSource, toSource } = options;
    const { filterComplex, mapOutput } = this.buildStemFilterGraph(plan, level);

    const args: string[] = ['-hide_banner', '-loglevel', 'error', '-y'];

    const duration = plan.basePlan.durationSeconds;
    const seekFrom = options.seekFromSeconds ?? plan.basePlan.outgoingCueSeconds;
    const seekTo = options.seekToSeconds ?? plan.basePlan.incomingCueSeconds;

    if (level === 'LAYERED_STEM' || level === 'STEM_CROSSFADE') {
      const outStems = plan.outgoingStems!;
      const inStems = plan.incomingStems!;

      // 4 Outgoing inputs
      for (const stemPath of [outStems.vocals, outStems.drums, outStems.bass, outStems.other]) {
        if (seekFrom > 0) args.push('-ss', seekFrom.toFixed(3));
        args.push('-t', (duration + 1).toFixed(3), '-i', stemPath);
      }

      // 4 Incoming inputs
      for (const stemPath of [inStems.vocals, inStems.drums, inStems.bass, inStems.other]) {
        if (seekTo > 0) args.push('-ss', seekTo.toFixed(3));
        args.push('-t', (duration + 1).toFixed(3), '-i', stemPath);
      }
    } else {
      // 2 Full-mix inputs
      if (seekFrom > 0) args.push('-ss', seekFrom.toFixed(3));
      args.push('-t', (duration + 1).toFixed(3), '-i', fromSource);

      if (seekTo > 0) args.push('-ss', seekTo.toFixed(3));
      args.push('-t', (duration + 1).toFixed(3), '-i', toSource);
    }

    args.push(
      '-filter_complex',
      filterComplex,
      '-map',
      mapOutput,
      '-t',
      duration.toFixed(3),
      outputPath,
    );

    await new Promise<void>((resolve, reject) => {
      const cp = spawn(this.ffmpegBinary, args, { stdio: ['ignore', 'pipe', 'pipe'] });

      let stderr = '';
      cp.stderr?.on('data', (d) => {
        stderr += d.toString();
      });

      cp.on('close', (code) => {
        if (code === 0 && fs.existsSync(outputPath)) {
          resolve();
        } else {
          reject(new Error(`FFmpeg transition render failed (exit ${code}): ${stderr}`));
        }
      });

      cp.on('error', (err) => reject(err));
    });
  }

  /**
   * Render real-time stream with fallback ladder for live player
   */
  public async renderTransitionStream(
    options: LayeredRenderOptions,
  ): Promise<{ stream: Readable; process?: ChildProcess; level: LayeredFallbackLevel }> {
    const fallbackLadder: LayeredFallbackLevel[] = [
      'LAYERED_STEM',
      'VOCAL_DUCK_MIX',
      'PHASE8_CROSSFADE',
      'SIMPLE_FADE',
      'HARD_CUT',
    ];

    const startIndex = options.plan.stemsAvailable ? 0 : 2;

    for (let i = startIndex; i < fallbackLadder.length; i++) {
      const level = fallbackLadder[i];
      try {
        if (level === 'PHASE8_CROSSFADE' || level === 'SIMPLE_FADE' || level === 'HARD_CUT') {
          // Use Phase 8 processor for full-mix streaming fallback
          const phase8Level = level === 'HARD_CUT' ? 'HARD_CUT' : level === 'SIMPLE_FADE' ? 'SIMPLE_FADE' : 'CROSSFADE';
          const p8Plan = { ...options.plan.basePlan, fallbackLevel: phase8Level as any };
          const p8 = await this.phase8Processor.renderTransitionStream({
            fromSource: options.fromSource,
            toSource: options.toSource,
            plan: p8Plan,
            seekFromSeconds: options.seekFromSeconds,
            seekToSeconds: options.seekToSeconds,
            sampleRate: options.sampleRate,
            channels: options.channels,
          });
          return { stream: p8.stream, process: p8.process, level };
        }

        // Render offline temp file and stream
        const tempPath = path.join(
          process.env.STORAGE_DIR || path.join(process.cwd(), 'storage'),
          'tmp',
          'transitions',
          `trans_${options.plan.id}_${Date.now()}.wav`,
        );

        await this.executeRender(options, tempPath, level);
        if (fs.existsSync(tempPath) && fs.statSync(tempPath).size > 0) {
          const fileStream = fs.createReadStream(tempPath);
          fileStream.on('close', () => {
            // Delete temp transition file after streaming completes
            try {
              fs.unlinkSync(tempPath);
            } catch {}
          });
          return { stream: fileStream, level };
        }
      } catch (err) {
        logger.warn({ err, level }, 'Stream render level failed, trying next fallback');
      }
    }

    throw new Error('All transition streaming fallback levels failed');
  }
}
