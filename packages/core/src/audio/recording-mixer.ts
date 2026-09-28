import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../utils/logger';
import { createWavHeader, extractPcmFromWav, pcmToWav, parseWavHeader } from './wav-utils';

const logger = createLogger('recording-mixer');

export interface ParticipantTrackInput {
  userId: string;
  displayName?: string;
  filePath: string;
  startOffsetMs?: number;
  timelineOffsetMs?: number;
  durationMs?: number;
}

export interface MixTracksOptions {
  tracks: ParticipantTrackInput[];
  outputPath?: string;
  outputWavPath?: string;
}

export interface MixResult {
  mixedFilePath: string;
  durationSeconds: number;
  fileSizeBytes: number;
  sampleRate: number;
  channels: number;
  participantCount: number;
  format: string;
}

/**
 * RecordingMixer mixes per-user audio tracks aligned along a master timeline.
 * Handles silence padding, sample summation, and headroom limiting.
 */
export class RecordingMixer {
  private readonly sampleRate: number;
  private readonly channels: number;
  private readonly bytesPerSample: number;

  constructor(options: { sampleRate?: number; channels?: number } = {}) {
    this.sampleRate = options.sampleRate || 48000;
    this.channels = options.channels || 2;
    this.bytesPerSample = 2; // 16-bit PCM
  }

  /**
   * Mix multiple participant audio tracks into a single WAV file.
   *
   * @param tracksOrOptions - Array of participant audio tracks or options object
   * @param maybeOutputWavPath - Optional output path if tracks passed as array
   */
  async mixTracks(
    tracksOrOptions: ParticipantTrackInput[] | MixTracksOptions,
    maybeOutputWavPath?: string
  ): Promise<MixResult> {
    let tracks: ParticipantTrackInput[];
    let outputWavPath: string;

    if (Array.isArray(tracksOrOptions)) {
      tracks = tracksOrOptions;
      outputWavPath = maybeOutputWavPath || '';
    } else {
      tracks = tracksOrOptions.tracks;
      outputWavPath = tracksOrOptions.outputWavPath || tracksOrOptions.outputPath || maybeOutputWavPath || '';
    }
    const validTracks: Array<{
      userId: string;
      displayName: string;
      pcm: Buffer;
      startOffsetMs: number;
      durationMs: number;
    }> = [];

    // 1. Read and validate each participant track
    for (const t of tracks) {
      if (!fs.existsSync(t.filePath)) {
        logger.warn({ filePath: t.filePath, userId: t.userId }, 'Participant audio file not found, skipping');
        continue;
      }

      const stat = fs.statSync(t.filePath);
      if (stat.size < 44) {
        logger.warn({ filePath: t.filePath, size: stat.size }, 'Participant audio file too small, skipping');
        continue;
      }

      try {
        const fileBuf = fs.readFileSync(t.filePath);
        let pcm: Buffer;
        let durationMs: number;

        if (fileBuf.toString('ascii', 0, 4) === 'RIFF') {
          const extracted = extractPcmFromWav(fileBuf);
          pcm = extracted.pcm;
          durationMs = extracted.header.durationMs;
        } else {
          // Raw PCM
          pcm = fileBuf;
          const bytesPerSec = this.sampleRate * this.channels * this.bytesPerSample;
          durationMs = Math.round((pcm.length / bytesPerSec) * 1000);
        }

        if (pcm.length > 0) {
          validTracks.push({
            userId: t.userId,
            displayName: t.displayName || `User ${t.userId}`,
            pcm,
            startOffsetMs: Math.max(0, t.startOffsetMs ?? t.timelineOffsetMs ?? 0),
            durationMs,
          });
        }
      } catch (err) {
        logger.error({ err, filePath: t.filePath }, 'Failed to read participant audio for mixing');
      }
    }

    // Ensure output directory exists
    const outDir = path.dirname(outputWavPath);
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    const bytesPerFrame = this.channels * this.bytesPerSample;
    const bytesPerMs = (this.sampleRate * bytesPerFrame) / 1000;

    // Handle edge case: no valid participant audio
    if (validTracks.length === 0) {
      logger.warn('No valid audio tracks to mix. Generating 1-second empty WAV.');
      const silenceBytes = Math.floor(bytesPerMs * 1000);
      const emptyWav = pcmToWav(Buffer.alloc(silenceBytes), this.sampleRate, this.channels);
      fs.writeFileSync(outputWavPath, emptyWav);
      return {
        mixedFilePath: outputWavPath,
        durationSeconds: 1,
        fileSizeBytes: emptyWav.length,
        sampleRate: this.sampleRate,
        channels: this.channels,
        participantCount: 0,
        format: 'wav',
      };
    }

    // 2. Compute master timeline length in milliseconds and bytes
    let maxEndMs = 0;
    for (const t of validTracks) {
      const endMs = t.startOffsetMs + t.durationMs;
      if (endMs > maxEndMs) {
        maxEndMs = endMs;
      }
    }
    // At least 1000ms
    maxEndMs = Math.max(1000, maxEndMs);

    const totalFrames = Math.ceil((maxEndMs / 1000) * this.sampleRate);
    const totalSamples = totalFrames * this.channels;
    const mixedPcm = new Int32Array(totalSamples); // 32-bit accumulator to avoid intermediate overflow

    // 3. Accumulate each participant track at their respective timestamp offset
    for (const t of validTracks) {
      const startFrame = Math.floor((t.startOffsetMs / 1000) * this.sampleRate);
      const startSampleIndex = startFrame * this.channels;
      const trackPcm = t.pcm;
      const numSamples = Math.floor(trackPcm.length / 2);

      for (let i = 0; i < numSamples; i++) {
        const targetIndex = startSampleIndex + i;
        if (targetIndex < totalSamples) {
          const sample16 = trackPcm.readInt16LE(i * 2);
          mixedPcm[targetIndex] += sample16;
        }
      }
    }

    // 4. Soft-limiting & Normalization
    // Find peak amplitude across all samples
    let maxPeak = 0;
    for (let i = 0; i < totalSamples; i++) {
      const absVal = Math.abs(mixedPcm[i]);
      if (absVal > maxPeak) {
        maxPeak = absVal;
      }
    }

    // Target peak around -1 dBFS (~29,000 out of 32,767)
    let gain = 1.0;
    if (maxPeak > 32000) {
      gain = 30000 / maxPeak;
      logger.info({ maxPeak, gain }, '[MIXER] Applied headroom scaling to prevent clipping');
    }

    // 5. Convert 32-bit accumulator back to 16-bit PCM buffer with soft clipping
    const outputBuffer = Buffer.alloc(totalSamples * 2);
    for (let i = 0; i < totalSamples; i++) {
      let scaled = mixedPcm[i] * gain;

      // Soft clip tanh approximation if still near ceiling
      if (scaled > 32767) {
        scaled = 32767;
      } else if (scaled < -32768) {
        scaled = -32768;
      }

      outputBuffer.writeInt16LE(Math.round(scaled), i * 2);
    }

    // 6. Write finalized WAV file
    const wavHeader = createWavHeader(outputBuffer.length, this.sampleRate, this.channels, 16);
    const finalWavBuffer = Buffer.concat([wavHeader, outputBuffer]);
    fs.writeFileSync(outputWavPath, finalWavBuffer);

    const durationSeconds = Math.round(maxEndMs / 1000);
    logger.info(
      {
        outputWavPath,
        durationSeconds,
        fileSizeBytes: finalWavBuffer.length,
        participantCount: validTracks.length,
      },
      '[MIXER] Mixed %d participant tracks into %s',
      validTracks.length,
      outputWavPath
    );

    return {
      mixedFilePath: outputWavPath,
      durationSeconds,
      fileSizeBytes: finalWavBuffer.length,
      sampleRate: this.sampleRate,
      channels: this.channels,
      participantCount: validTracks.length,
      format: 'wav',
    };
  }
}
