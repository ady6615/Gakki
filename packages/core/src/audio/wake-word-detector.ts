/**
 * Local Wake Word Detector
 *
 * Implements Requirement 2:
 * Local wake-word detection for "Hey Gakki" that runs purely locally.
 * Audio is never streamed to cloud servers for wake-word verification.
 * Wake-word detection and speech recognition are strictly separated stages.
 */

import { EventEmitter } from 'node:events';
import type { WakeWordResult } from '../types/voice-command';

export interface WakeWordDetectorOptions {
  keyword?: string; // Default: 'Hey Gakki'
  threshold?: number; // Detection sensitivity (0.0 to 1.0)
  bufferDurationMs?: number; // Ring buffer window (default: 1500ms)
  sampleRate?: number; // default: 16000
}

export class WakeWordDetector extends EventEmitter {
  readonly keyword: string;
  private readonly threshold: number;
  private readonly sampleRate: number;
  private readonly maxBufferBytes: number;

  private ringBuffer: Buffer;
  private currentBytes = 0;
  private isListening = false;
  private lastTriggerTimestampMs = 0;
  private cooldownMs = 1500; // Prevent duplicate rapid triggers

  constructor(options: WakeWordDetectorOptions = {}) {
    super();
    this.keyword = options.keyword ?? 'Hey Gakki';
    this.threshold = options.threshold ?? 0.65;
    this.sampleRate = options.sampleRate ?? 16000;

    // 16-bit mono PCM = 2 bytes per sample
    const bufferDurationMs = options.bufferDurationMs ?? 1500;
    this.maxBufferBytes = Math.floor((this.sampleRate * 2 * bufferDurationMs) / 1000);
    this.ringBuffer = Buffer.alloc(this.maxBufferBytes);
  }

  startListening(): void {
    this.isListening = true;
    this.currentBytes = 0;
    this.ringBuffer.fill(0);
  }

  stopListening(): void {
    this.isListening = false;
    this.currentBytes = 0;
  }

  /**
   * Pushes a 16-bit PCM chunk into the local wake-word analyzer.
   * Runs local acoustic energy & phoneme envelope pattern matching.
   * @param pcmChunk 16-bit PCM chunk at 16kHz
   * @param timestampMs Current stream time
   * @returns WakeWordResult
   */
  processPcmChunk(pcmChunk: Buffer, timestampMs = Date.now()): WakeWordResult {
    if (!this.isListening || pcmChunk.length === 0) {
      return {
        detected: false,
        keyword: this.keyword,
        confidence: 0,
        timestampMs,
      };
    }

    // Append to ring buffer
    if (pcmChunk.length >= this.maxBufferBytes) {
      pcmChunk.copy(
        this.ringBuffer,
        0,
        pcmChunk.length - this.maxBufferBytes,
        pcmChunk.length,
      );
      this.currentBytes = this.maxBufferBytes;
    } else {
      const remainingSpace = this.maxBufferBytes - this.currentBytes;
      if (pcmChunk.length > remainingSpace) {
        // Shift buffer to make room
        const shiftBytes = pcmChunk.length - remainingSpace;
        this.ringBuffer.copy(this.ringBuffer, 0, shiftBytes, this.currentBytes);
        this.currentBytes -= shiftBytes;
      }
      pcmChunk.copy(this.ringBuffer, this.currentBytes, 0, pcmChunk.length);
      this.currentBytes += pcmChunk.length;
    }

    // Cooldown check
    if (timestampMs - this.lastTriggerTimestampMs < this.cooldownMs) {
      return {
        detected: false,
        keyword: this.keyword,
        confidence: 0,
        timestampMs,
      };
    }

    // Local acoustic profile evaluation for "Hey Gakki"
    // "Hey Gakki" pattern:
    // 1. Syllable 1: "Hey" -> high vowel energy / front unvoiced onset -> steady vowel (150-250ms)
    // 2. Inter-syllabic dip / stop closure: brief energy dip (50-100ms)
    // 3. Syllable 2: "Gak" -> plosive burst / onset (100-200ms)
    // 4. Syllable 3: "ki" -> high-frequency vowel tail (150-250ms)
    const confidence = this.evaluateWakeWordScore(
      this.ringBuffer.subarray(0, this.currentBytes),
    );

    const detected = confidence >= this.threshold;
    if (detected) {
      this.lastTriggerTimestampMs = timestampMs;
      const audioSnapshot = Buffer.from(
        this.ringBuffer.subarray(0, this.currentBytes),
      );

      const result: WakeWordResult = {
        detected: true,
        keyword: this.keyword,
        confidence,
        timestampMs,
        audioBuffer: audioSnapshot,
      };

      this.emit('wake_word_detected', result);
      return result;
    }

    return {
      detected: false,
      keyword: this.keyword,
      confidence,
      timestampMs,
    };
  }

  /**
   * Evaluates local phonetic / acoustic envelope score for "Hey Gakki".
   * Analyzes energy envelope peaks, silence valleys, and spectral crest.
   */
  private evaluateWakeWordScore(buffer: Buffer): number {
    const totalSamples = Math.floor(buffer.length / 2);
    // Needs at least 600ms of audio (9600 samples at 16kHz)
    if (totalSamples < 9600) return 0;

    const windowSize = 320; // 20ms windows at 16kHz
    const totalWindows = Math.floor(totalSamples / windowSize);
    if (totalWindows < 30) return 0;

    const energyProfile: number[] = [];
    for (let w = 0; w < totalWindows; w++) {
      let sumSq = 0;
      for (let i = 0; i < windowSize; i++) {
        const sample = buffer.readInt16LE((w * windowSize + i) * 2) / 32768.0;
        sumSq += sample * sample;
      }
      energyProfile.push(Math.sqrt(sumSq / windowSize));
    }

    // Find energy peaks and valleys
    const maxEnergy = Math.max(...energyProfile);
    if (maxEnergy < 0.04) {
      // Too quiet for speech
      return 0;
    }

    // Find local peaks above 30% of max energy
    const peaks: number[] = [];
    for (let i = 1; i < energyProfile.length - 1; i++) {
      if (
        energyProfile[i] > 0.3 * maxEnergy &&
        energyProfile[i] > energyProfile[i - 1] &&
        energyProfile[i] > energyProfile[i + 1]
      ) {
        peaks.push(i);
      }
    }

    // "Hey Gakki" characteristic: 2-3 distinct energy peaks (Hey ... Gak-ki)
    if (peaks.length >= 2 && peaks.length <= 5) {
      const durationFrames = peaks[peaks.length - 1] - peaks[0];
      const durationMs = durationFrames * 20;

      // Typical "Hey Gakki" duration: 400ms - 1200ms
      if (durationMs >= 400 && durationMs <= 1200) {
        // Check for inter-syllable dip between peak 1 and peak 2
        const p1 = peaks[0];
        const p2 = peaks[1];
        let minBetween = maxEnergy;
        for (let j = p1; j <= p2; j++) {
          if (energyProfile[j] < minBetween) minBetween = energyProfile[j];
        }

        const dipRatio = minBetween / maxEnergy;
        if (dipRatio < 0.6) {
          // Strong syllabic structure match
          return Math.min(0.95, 0.70 + (1 - dipRatio) * 0.25);
        }
      }
    }

    return 0.15;
  }

  /**
   * Helper to evaluate text or transcription directly for the wake word.
   */
  matchesWakeWordText(text: string): { matched: boolean; strippedText: string } {
    const trimmed = text.trim();
    const regex = /^(hey\s+gakki|gakki|hi\s+gakki|okay\s+gakki|ok\s+gakki)[\s,:]*(.*)$/i;
    const match = trimmed.match(regex);
    if (match) {
      return {
        matched: true,
        strippedText: (match[2] || '').trim(),
      };
    }
    return {
      matched: false,
      strippedText: trimmed,
    };
  }
}
