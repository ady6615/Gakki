import { spawn, type ChildProcess } from 'node:child_process';
import type { AudioFilterConfig } from '@gakki/core';
import { createLogger } from '@gakki/core';
import { getFfmpegPath } from './ffmpeg';

const logger = createLogger('audio-filters');

/**
 * Clamp user volume to valid [0, 200] range.
 */
export function clampVolume(volume: number): number {
  if (isNaN(volume)) return 100;
  return Math.max(0, Math.min(200, Math.round(volume)));
}

/**
 * Build chained FFmpeg `atempo` filters for speeds that exceed the single-filter range [0.5, 2.0].
 * Each `atempo` filter in FFmpeg strictly accepts [0.5, 2.0].
 *
 * Example:
 * - 1.5 -> ['atempo=1.5']
 * - 2.5 -> ['atempo=2.0', 'atempo=1.25']
 * - 0.25 -> ['atempo=0.5', 'atempo=0.5']
 */
export function buildAtempoFilterChain(targetSpeed: number): string[] {
  const filters: string[] = [];
  let speed = targetSpeed;

  if (speed <= 0 || isNaN(speed)) {
    speed = 1.0;
  }

  while (speed > 2.0) {
    filters.push('atempo=2.0');
    speed /= 2.0;
  }

  while (speed < 0.5) {
    filters.push('atempo=0.5');
    speed /= 0.5;
  }

  // Only append if there is an audible difference from 1.0
  if (Math.abs(speed - 1.0) > 0.005) {
    filters.push(`atempo=${speed.toFixed(3)}`);
  }

  return filters;
}

/**
 * Calculate the effective audio playback speed combining user speed and nightcore.
 * Formula: effectiveSpeed = userSpeed * (nightcore ? 1.25 : 1.0)
 */
export function calculateEffectiveSpeed(userSpeed: number, nightcore: boolean): number {
  const base = Math.max(0.25, Math.min(4.0, userSpeed));
  const nightcoreMultiplier = nightcore ? 1.25 : 1.0;
  return Math.round(base * nightcoreMultiplier * 1000) / 1000;
}

/**
 * Build complete FFmpeg `-af` audio filter chain from configuration.
 */
export function buildAudioFilterArgs(filters?: AudioFilterConfig): string[] {
  if (!filters) return [];

  const filterNodes: string[] = [];

  // 1. Bassboost (conservative +5dB gain to prevent digital clipping)
  if (filters.bassboost) {
    filterNodes.push('bass=g=5:f=110:w=0.6');
  }

  // 2. Nightcore (pitch shift + tempo modification via asetrate)
  if (filters.nightcore) {
    // 48000 * 1.25 = 60000, shifts pitch up by 25% and tempo by 1.25x
    filterNodes.push('asetrate=48000*1.25,aresample=48000');
    // Apply user speed offset if userSpeed is not 1.0
    if (Math.abs(filters.speed - 1.0) > 0.005) {
      filterNodes.push(...buildAtempoFilterChain(filters.speed));
    }
  } else {
    // Standard speed adjustment (without pitch shift)
    if (Math.abs(filters.speed - 1.0) > 0.005) {
      filterNodes.push(...buildAtempoFilterChain(filters.speed));
    }
  }

  return filterNodes;
}

/**
 * Options for spawning a filtered FFmpeg stream.
 */
export interface FilteredStreamOptions {
  filters?: AudioFilterConfig;
  seekSeconds?: number;
}

/**
 * Spawn an FFmpeg process with custom audio filter processing and output 48kHz stereo raw PCM.
 *
 * @param filePath - Absolute path to local audio file
 * @param options - Audio filters and optional seek offset in seconds
 */
export function createFilteredFfmpegProcess(
  filePath: string,
  options: FilteredStreamOptions = {},
): ChildProcess {
  const ffmpegExe = getFfmpegPath();
  const args: string[] = [];

  // Seek position if resuming after filter change
  if (options.seekSeconds && options.seekSeconds > 0) {
    args.push('-ss', options.seekSeconds.toFixed(3));
  }

  args.push('-i', filePath);

  // Apply audio filters if any are active
  const filterList = buildAudioFilterArgs(options.filters);
  if (filterList.length > 0) {
    args.push('-af', filterList.join(','));
  }

  // Output 48kHz 16-bit stereo raw PCM to stdout pipe:1
  args.push('-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1');

  logger.debug({ filePath, args, filters: options.filters }, 'Spawning filtered FFmpeg process');

  const proc = spawn(ffmpegExe, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  proc.stderr.on('data', (chunk) => {
    logger.trace({ chunk: chunk.toString() }, 'FFmpeg stderr');
  });

  proc.on('error', (err) => {
    logger.error({ err, filePath }, 'FFmpeg process error');
  });

  return proc;
}
