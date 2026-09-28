import { execFile } from 'node:child_process';
import { getFfmpegPath } from './ffmpeg';
import { createLogger } from '@gakki/core';

const logger = createLogger('ffmpeg-capabilities');

export interface FFmpegFilterCapabilities {
  acrossfade: boolean;
  rubberband: boolean;
  loudnorm: boolean;
  atempo: boolean;
  volume: boolean;
  asetrate: boolean;
  binaryPath: string;
  detectedAt: Date;
}

let cachedCapabilities: FFmpegFilterCapabilities | null = null;

/**
 * Detect capabilities of the FFmpeg binary at startup.
 * Checks specifically for librubberband, acrossfade, loudnorm, atempo, volume, asetrate.
 */
export async function detectFFmpegCapabilities(
  customPath?: string,
): Promise<FFmpegFilterCapabilities> {
  if (cachedCapabilities && !customPath) {
    return cachedCapabilities;
  }

  const binaryPath =
    customPath ||
    process.env.DJ_FFMPEG_PATH ||
    process.env.TRANSITION_FFMPEG_PATH ||
    getFfmpegPath();

  return new Promise((resolve) => {
    execFile(binaryPath, ['-filters'], (error, stdout, stderr) => {
      const output = `${stdout || ''}\n${stderr || ''}`;

      const capabilities: FFmpegFilterCapabilities = {
        acrossfade: /\bacrossfade\b/i.test(output),
        rubberband: /\brubberband\b/i.test(output),
        loudnorm: /\bloudnorm\b/i.test(output),
        atempo: /\batempo\b/i.test(output),
        volume: /\bvolume\b/i.test(output),
        asetrate: /\basetrate\b/i.test(output),
        binaryPath,
        detectedAt: new Date(),
      };

      if (!customPath) {
        cachedCapabilities = capabilities;
      }

      logger.info(
        {
          binaryPath,
          acrossfade: capabilities.acrossfade,
          rubberband: capabilities.rubberband,
          loudnorm: capabilities.loudnorm,
          atempo: capabilities.atempo,
          volume: capabilities.volume,
          asetrate: capabilities.asetrate,
        },
        'FFmpeg capability detection completed',
      );

      resolve(capabilities);
    });
  });
}

/**
 * Get synchronously cached capabilities or null if not yet detected.
 */
export function getFFmpegCapabilities(): FFmpegFilterCapabilities | null {
  return cachedCapabilities;
}
