import { execFile } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import type { AudioMetadata } from '@gakki/core';
import { createLogger } from '@gakki/core';

const logger = createLogger('ffmpeg');

// Ensure FFMPEG_PATH is available globally for prism-media and @discordjs/voice
if (ffmpegPath) {
  process.env.FFMPEG_PATH = ffmpegPath;
}

/**
 * Probe audio metadata (duration, title, artist) from a file using FFmpeg.
 */
export async function probeAudioMetadata(filePath: string): Promise<Partial<AudioMetadata>> {
  return new Promise((resolve) => {
    if (!ffmpegPath) {
      resolve({});
      return;
    }

    execFile(ffmpegPath, ['-i', filePath], (error, _stdout, stderr) => {
      // FFmpeg outputs info to stderr and exits with non-zero when no output file is given
      const result: Partial<AudioMetadata> = {};

      if (!stderr) {
        resolve(result);
        return;
      }

      // Parse duration: Duration: 00:01:23.45
      const durationMatch = stderr.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/i);
      if (durationMatch) {
        const hours = parseFloat(durationMatch[1]);
        const minutes = parseFloat(durationMatch[2]);
        const seconds = parseFloat(durationMatch[3]);
        result.duration = Math.round(hours * 3600 + minutes * 60 + seconds);
      }

      // Parse title
      const titleMatch = stderr.match(/^\s*title\s*:\s*(.+)$/im);
      if (titleMatch) {
        result.title = titleMatch[1].trim();
      }

      // Parse artist
      const artistMatch = stderr.match(/^\s*artist\s*:\s*(.+)$/im);
      if (artistMatch) {
        result.artist = artistMatch[1].trim();
      }

      // Parse album
      const albumMatch = stderr.match(/^\s*album\s*:\s*(.+)$/im);
      if (albumMatch) {
        result.album = albumMatch[1].trim();
      }

      logger.debug({ filePath, result }, 'Audio file probed');
      resolve(result);
    });
  });
}

/**
 * Get the resolved FFmpeg executable path.
 */
export function getFfmpegPath(): string {
  return ffmpegPath || 'ffmpeg';
}
