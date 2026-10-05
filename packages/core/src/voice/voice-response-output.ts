/**
 * Voice Response Output Manager
 *
 * Implements Requirements 12 & 13:
 * - Keeps AI voice-agent audio output separated from music audio.
 * - Converts 24kHz PCM from Gemini Live to 48kHz stereo PCM.
 * - Implements voice interruption (barge-in): immediately cancels or ducks Gakki speaking
 *   when user starts speaking.
 */

import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { AudioResampler } from '../audio/audio-resampler';

export interface VoicePlaybackChunk {
  pcm48kStereo: Buffer;
  timestampMs: number;
}

export class VoiceResponseOutput extends EventEmitter {
  private isSpeaking = false;
  private currentStream: PassThrough | null = null;
  private queuedBuffers: Buffer[] = [];
  private isInterrupted = false;

  constructor() {
    super();
  }

  /**
   * Pushes raw 24kHz PCM audio chunk from Gemini Live / TTS.
   * Automatically upsamples to 48kHz stereo 16-bit PCM and dispatches to voice output.
   */
  pushAudio24k(pcm24kMono: Buffer): void {
    if (this.isInterrupted) {
      // Barge-in active; drop incoming AI speech
      return;
    }

    const pcm48kStereo = AudioResampler.upsample24kTo48kStereo(pcm24kMono);
    this.pushAudio48k(pcm48kStereo);
  }

  /**
   * Pushes 48kHz stereo 16-bit PCM chunk directly.
   */
  pushAudio48k(pcm48kStereo: Buffer): void {
    if (this.isInterrupted || pcm48kStereo.length === 0) return;

    if (!this.isSpeaking) {
      this.isSpeaking = true;
      this.currentStream = new PassThrough();
      this.emit('speaking_start', {
        stream: this.currentStream,
        timestampMs: Date.now(),
      });
    }

    this.queuedBuffers.push(pcm48kStereo);
    if (this.currentStream && !this.currentStream.destroyed) {
      this.currentStream.write(pcm48kStereo);
    }

    this.emit('audio_chunk', {
      pcm48kStereo,
      timestampMs: Date.now(),
    });
  }

  /**
   * Signals that Gemini Live or TTS has finished speaking the current sentence/response.
   */
  finishSpeaking(): void {
    if (this.currentStream && !this.currentStream.destroyed) {
      this.currentStream.end();
    }
    this.isSpeaking = false;
    this.isInterrupted = false;
    this.currentStream = null;
    this.queuedBuffers = [];
    this.emit('speaking_end', { timestampMs: Date.now() });
  }

  /**
   * Interrupts active voice playback immediately (Barge-in).
   * Used when user speech is detected by VAD while Gakki is speaking.
   */
  interrupt(): void {
    if (!this.isSpeaking && this.queuedBuffers.length === 0) return;

    this.isInterrupted = true;
    this.isSpeaking = false;
    this.queuedBuffers = [];

    if (this.currentStream) {
      this.currentStream.destroy();
      this.currentStream = null;
    }

    this.emit('barge_in_interrupted', {
      timestampMs: Date.now(),
      reason: 'User speech started during AI output',
    });
  }

  /**
   * Resets interruption state to allow new voice responses.
   */
  resetInterruption(): void {
    this.isInterrupted = false;
  }

  isCurrentlySpeaking(): boolean {
    return this.isSpeaking;
  }

  getQueuedAudioDurationSeconds(): number {
    const totalBytes = this.queuedBuffers.reduce((acc, b) => acc + b.length, 0);
    // 48000 frames/sec * 2 channels * 2 bytes = 192,000 bytes/sec
    return totalBytes / 192000;
  }
}
