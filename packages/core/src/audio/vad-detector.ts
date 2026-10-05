/**
 * Voice Activity Detection (VAD)
 *
 * Implements Requirement 4:
 * Local VAD before speech recognition to ignore silence and process speech,
 * minimizing API usage, latency, and accidental commands.
 */

import { EventEmitter } from 'node:events';
import type { VADEvent, VADOptions, VADState } from '../types/voice-command';

export class VoiceActivityDetector extends EventEmitter {
  private readonly energyThresholdRms: number;
  private readonly silenceHangoverMs: number;
  private readonly minSpeechDurationMs: number;
  private readonly sampleRate: number;

  private currentState: VADState = 'silence';
  private speechStartTimestampMs = 0;
  private lastSpeechTimestampMs = 0;
  private silenceStartTimestampMs = 0;
  private consecutiveSpeechFrames = 0;
  private consecutiveSilenceFrames = 0;

  constructor(options: VADOptions = {}) {
    super();
    this.energyThresholdRms = options.energyThresholdRms ?? 0.025; // standard RMS threshold
    this.silenceHangoverMs = options.silenceHangoverMs ?? 350; // hangover window
    this.minSpeechDurationMs = options.minSpeechDurationMs ?? 150; // min duration to trigger speech
    this.sampleRate = options.sampleRate ?? 16000;
  }

  /**
   * Computes the Root Mean Square (RMS) energy of a 16-bit PCM buffer.
   */
  static calculateRms(pcmBuffer: Buffer): number {
    const totalSamples = Math.floor(pcmBuffer.length / 2);
    if (totalSamples === 0) return 0;

    let sumSquares = 0;
    for (let i = 0; i < totalSamples; i++) {
      const sample = pcmBuffer.readInt16LE(i * 2) / 32768.0;
      sumSquares += sample * sample;
    }

    return Math.sqrt(sumSquares / totalSamples);
  }

  /**
   * Computes Zero-Crossing Rate (ZCR) to differentiate unvoiced speech/fricatives from low-frequency noise.
   */
  static calculateZcr(pcmBuffer: Buffer): number {
    const totalSamples = Math.floor(pcmBuffer.length / 2);
    if (totalSamples < 2) return 0;

    let zeroCrossings = 0;
    let prevSign = pcmBuffer.readInt16LE(0) >= 0;

    for (let i = 1; i < totalSamples; i++) {
      const currentSign = pcmBuffer.readInt16LE(i * 2) >= 0;
      if (currentSign !== prevSign) {
        zeroCrossings++;
        prevSign = currentSign;
      }
    }

    return zeroCrossings / totalSamples;
  }

  /**
   * Processes a chunk of 16-bit PCM audio (typically 10-100ms) and updates VAD state.
   * @param pcmChunk 16-bit PCM audio chunk (at this.sampleRate)
   * @param timestampMs Current stream timestamp in milliseconds
   * @returns VADEvent with current state and metrics
   */
  processFrame(pcmChunk: Buffer, timestampMs = Date.now()): VADEvent {
    const rms = VoiceActivityDetector.calculateRms(pcmChunk);
    const zcr = VoiceActivityDetector.calculateZcr(pcmChunk);

    // Frame contains speech if energy exceeds threshold (with slight weight for high ZCR fricatives)
    const isFrameSpeech = rms >= this.energyThresholdRms || (rms >= this.energyThresholdRms * 0.6 && zcr > 0.15);

    if (isFrameSpeech) {
      this.consecutiveSpeechFrames++;
      this.consecutiveSilenceFrames = 0;
      this.lastSpeechTimestampMs = timestampMs;

      if (this.currentState === 'silence') {
        if (this.speechStartTimestampMs === 0) {
          this.speechStartTimestampMs = timestampMs;
        }

        const elapsedSpeech = timestampMs - this.speechStartTimestampMs;
        if (elapsedSpeech >= this.minSpeechDurationMs) {
          this.currentState = 'speech';
          this.silenceStartTimestampMs = 0;

          const event: VADEvent = {
            state: 'speech',
            timestampMs,
            energyRms: rms,
            speechDurationMs: elapsedSpeech,
          };
          this.emit('speech_start', event);
          this.emit('vad_state_changed', event);
          return event;
        }
      }
    } else {
      // Frame is silence
      this.consecutiveSilenceFrames++;
      this.consecutiveSpeechFrames = 0;

      if (this.currentState === 'speech') {
        if (this.silenceStartTimestampMs === 0) {
          this.silenceStartTimestampMs = timestampMs;
        }

        const silenceElapsed = timestampMs - this.silenceStartTimestampMs;
        if (silenceElapsed >= this.silenceHangoverMs) {
          this.currentState = 'silence';
          const totalSpeechDuration =
            this.silenceStartTimestampMs - this.speechStartTimestampMs;
          this.speechStartTimestampMs = 0;
          this.silenceStartTimestampMs = 0;

          const event: VADEvent = {
            state: 'silence',
            timestampMs,
            energyRms: rms,
            speechDurationMs: Math.max(0, totalSpeechDuration),
            silenceDurationMs: silenceElapsed,
          };
          this.emit('speech_end', event);
          this.emit('vad_state_changed', event);
          return event;
        }
      } else {
        this.speechStartTimestampMs = 0;
      }
    }

    const event: VADEvent = {
      state: this.currentState,
      timestampMs,
      energyRms: rms,
      speechDurationMs:
        this.currentState === 'speech' && this.speechStartTimestampMs > 0
          ? timestampMs - this.speechStartTimestampMs
          : 0,
      silenceDurationMs:
        this.currentState === 'silence' && this.silenceStartTimestampMs > 0
          ? timestampMs - this.silenceStartTimestampMs
          : 0,
    };

    return event;
  }

  getCurrentState(): VADState {
    return this.currentState;
  }

  isSpeechActive(): boolean {
    return this.currentState === 'speech';
  }

  reset(): void {
    this.currentState = 'silence';
    this.speechStartTimestampMs = 0;
    this.lastSpeechTimestampMs = 0;
    this.silenceStartTimestampMs = 0;
    this.consecutiveSpeechFrames = 0;
    this.consecutiveSilenceFrames = 0;
  }
}
