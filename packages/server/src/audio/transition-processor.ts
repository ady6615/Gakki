import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, PassThrough } from 'node:stream';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FallbackLevel, TransitionPlan } from '@gakki/core';
import { createLogger } from '@gakki/core';
import { getFfmpegPath } from './ffmpeg';
import {
  detectFFmpegCapabilities,
  getFFmpegCapabilities,
  type FFmpegFilterCapabilities,
} from './ffmpeg-capabilities';

const logger = createLogger('transition-processor');

export interface TransitionRenderOptions {
  fromSource: string; // File path or stream URL
  toSource: string; // File path or stream URL
  plan: TransitionPlan;
  seekFromSeconds?: number;
  seekToSeconds?: number;
  sampleRate?: number;
  channels?: number;
}

export class TransitionProcessor {
  private readonly ffmpegBinary: string;

  constructor(customBinaryPath?: string) {
    this.ffmpegBinary =
      customBinaryPath ||
      process.env.DJ_FFMPEG_PATH ||
      process.env.TRANSITION_FFMPEG_PATH ||
      getFfmpegPath();
  }

  /**
   * Build the FFmpeg filter_complex string according to the verified processing order:
   * Source -> Tempo Adjustment -> Pitch Adjustment -> Loudness Gain -> Acrossfade / Mix
   */
  buildFilterGraph(
    plan: TransitionPlan,
    capabilities: FFmpegFilterCapabilities,
    fallbackLevel: FallbackLevel,
  ): { filterComplex: string; mapOutput: string } {
    const {
      durationSeconds,
      curve,
      fromTrackGainDb,
      toTrackGainDb,
      tempoAdjustmentPercent,
      pitchShiftSemitones,
    } = plan;

    const safeCurve = curve || 'qsin';
    const safeDuration = Math.max(1, durationSeconds);

    // Level: HARD_CUT (No crossfade, seamless sequential concatenation)
    if (fallbackLevel === 'HARD_CUT') {
      const filter = `[0:a]aformat=sample_fmts=s16:channel_layouts=stereo,volume=${fromTrackGainDb.toFixed(2)}dB[a0];[1:a]aformat=sample_fmts=s16:channel_layouts=stereo,volume=${toTrackGainDb.toFixed(2)}dB[a1];[a0][a1]concat=n=2:v=0:a=1[out]`;
      return {
        filterComplex: filter,
        mapOutput: '[out]',
      };
    }

    // Level: SIMPLE_FADE (Linear fade out / in)
    if (fallbackLevel === 'SIMPLE_FADE') {
      const filter = `[0:a]volume=${fromTrackGainDb.toFixed(2)}dB,afade=t=out:d=${safeDuration}:curve=tri[a0];[1:a]volume=${toTrackGainDb.toFixed(2)}dB,afade=t=in:d=${safeDuration}:curve=tri[a1];[a0][a1]acrossfade=d=${safeDuration}:c1=tri:c2=tri:o=1[out]`;
      return { filterComplex: filter, mapOutput: '[out]' };
    }

    // Input 0 (Outgoing track tail): Volume normalization
    const in0Filter = `[0:a]volume=${fromTrackGainDb.toFixed(2)}dB[a0]`;

    // Input 1 (Incoming track intro): Tempo / Pitch / Gain
    const in1Filters: string[] = [];
    let currentIn1 = '1:a';

    const useAdvancedDSp = fallbackLevel === 'ADVANCED' && capabilities.rubberband;
    const tempoRatio = 1 + tempoAdjustmentPercent / 100;
    const pitchRatio = Math.pow(2, pitchShiftSemitones / 12);

    if (useAdvancedDSp && (tempoAdjustmentPercent !== 0 || pitchShiftSemitones !== 0)) {
      const parts: string[] = [];
      if (Math.abs(tempoAdjustmentPercent) > 0.05) {
        parts.push(`tempo=${tempoRatio.toFixed(4)}`);
      }
      if (pitchShiftSemitones !== 0) {
        parts.push(`pitch=${pitchRatio.toFixed(4)}`);
      }
      if (parts.length > 0) {
        in1Filters.push(`[${currentIn1}]rubberband=${parts.join(':')}[a1_mod]`);
        currentIn1 = 'a1_mod';
      }
    } else if (capabilities.atempo && Math.abs(tempoAdjustmentPercent) > 0.05) {
      // Graceful fallback to atempo if rubberband unavailable
      in1Filters.push(`[${currentIn1}]atempo=${tempoRatio.toFixed(4)}[a1_mod]`);
      currentIn1 = 'a1_mod';
    }

    // Apply incoming track loudness gain
    in1Filters.push(`[${currentIn1}]volume=${toTrackGainDb.toFixed(2)}dB[a1]`);

    // Crossfade filter with equal-power curve
    const crossfadeFilter = `[a0][a1]acrossfade=d=${safeDuration}:c1=${safeCurve}:c2=${safeCurve}:o=1[out]`;

    const fullGraph = [in0Filter, ...in1Filters, crossfadeFilter].join(';');
    return { filterComplex: fullGraph, mapOutput: '[out]' };
  }

  /**
   * Render the transition audio stream directly into raw 48kHz 16-bit stereo PCM.
   * Feeds directly into Discord audio player / voice adapter.
   */
  async renderTransitionStream(options: TransitionRenderOptions): Promise<{
    stream: Readable;
    process: ChildProcess;
    effectiveFallback: FallbackLevel;
  }> {
    const capabilities =
      getFFmpegCapabilities() || (await detectFFmpegCapabilities(this.ffmpegBinary));

    const levelsToTry: FallbackLevel[] = [
      options.plan.fallbackLevel,
      'CROSSFADE',
      'SIMPLE_FADE',
      'HARD_CUT',
    ];

    // Filter unique levels in order
    const ladder = Array.from(new Set(levelsToTry));

    for (const level of ladder) {
      try {
        const result = await this.spawnTransitionPipeline(options, capabilities, level);
        logger.info(
          {
            planId: options.plan.id,
            level,
            duration: options.plan.durationSeconds,
            curve: options.plan.curve,
          },
          'Transition render pipeline spawned successfully',
        );
        return { ...result, effectiveFallback: level };
      } catch (err) {
        logger.warn(
          { err, planId: options.plan.id, failedLevel: level },
          'Transition render level failed, descending fallback ladder',
        );
      }
    }

    throw new Error('All transition render fallback levels failed');
  }

  /**
   * Render the transition to an output audio file (e.g. WAV or MP3).
   * Used for offline verification and listening tests.
   */
  async renderTransitionToFile(
    options: TransitionRenderOptions,
    outputPath: string,
  ): Promise<string> {
    const capabilities =
      getFFmpegCapabilities() || (await detectFFmpegCapabilities(this.ffmpegBinary));

    const { filterComplex, mapOutput } = this.buildFilterGraph(
      options.plan,
      capabilities,
      options.plan.fallbackLevel,
    );

    const outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    const args: string[] = ['-y'];

    // Seek outgoing track if specified
    if (options.seekFromSeconds !== undefined && options.seekFromSeconds > 0) {
      args.push('-ss', options.seekFromSeconds.toFixed(3));
    }
    args.push('-i', options.fromSource);

    // Seek incoming track if specified
    if (options.seekToSeconds !== undefined && options.seekToSeconds > 0) {
      args.push('-ss', options.seekToSeconds.toFixed(3));
    }
    args.push('-i', options.toSource);

    args.push(
      '-filter_complex',
      filterComplex,
      '-map',
      mapOutput,
      outputPath,
    );

    return new Promise((resolve, reject) => {
      logger.debug({ args }, 'Executing offline transition render');
      const cp = spawn(this.ffmpegBinary, args, { stdio: ['ignore', 'pipe', 'pipe'] });

      let stderr = '';
      cp.stderr?.on('data', (d) => {
        stderr += d.toString();
      });

      cp.on('close', (code) => {
        if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
          resolve(outputPath);
        } else {
          reject(new Error(`FFmpeg transition render failed (exit ${code}): ${stderr}`));
        }
      });

      cp.on('error', (err) => reject(err));
    });
  }

  private async spawnTransitionPipeline(
    options: TransitionRenderOptions,
    capabilities: FFmpegFilterCapabilities,
    level: FallbackLevel,
  ): Promise<{ stream: Readable; process: ChildProcess }> {
    const { filterComplex, mapOutput } = this.buildFilterGraph(options.plan, capabilities, level);

    const args: string[] = ['-hide_banner', '-loglevel', 'error'];

    // Seek outgoing track
    if (options.seekFromSeconds !== undefined && options.seekFromSeconds > 0) {
      args.push('-ss', options.seekFromSeconds.toFixed(3));
    }
    args.push('-i', options.fromSource);

    // Seek incoming track
    if (options.seekToSeconds !== undefined && options.seekToSeconds > 0) {
      args.push('-ss', options.seekToSeconds.toFixed(3));
    }
    args.push('-i', options.toSource);

    args.push(
      '-filter_complex',
      filterComplex,
      '-map',
      mapOutput,
      '-f',
      's16le',
      '-ar',
      String(options.sampleRate || 48000),
      '-ac',
      String(options.channels || 2),
      'pipe:1',
    );

    const cp = spawn(this.ffmpegBinary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const passThrough = new PassThrough();
    cp.stdout.pipe(passThrough);

    let stderr = '';
    cp.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    return new Promise((resolve, reject) => {
      let isSettled = false;

      // Listen for initial data chunk to ensure FFmpeg started without immediate crash
      cp.stdout.once('data', (firstChunk) => {
        if (!isSettled) {
          isSettled = true;
          // Unshift first chunk back so downstream receives it
          passThrough.unshift(firstChunk);
          resolve({ stream: passThrough, process: cp });
        }
      });

      cp.once('error', (err) => {
        if (!isSettled) {
          isSettled = true;
          reject(err);
        }
      });

      cp.once('close', (code) => {
        if (!isSettled) {
          isSettled = true;
          if (code === 0) {
            resolve({ stream: passThrough, process: cp });
          } else {
            reject(new Error(`FFmpeg exited with code ${code}: ${stderr}`));
          }
        }
      });

      // Timeout safety: if no data within 3000ms, fail to next level
      setTimeout(() => {
        if (!isSettled) {
          isSettled = true;
          try {
            cp.kill('SIGKILL');
          } catch {}
          reject(new Error('FFmpeg transition startup timed out after 3000ms'));
        }
      }, 3000);
    });
  }
}
