/**
 * Local / Mock TTS Provider
 *
 * Provides deterministic, offline voice synthesis for development, testing,
 * CI pipelines, and offline fallbacks. Synthesizes valid 24kHz/48kHz 16-bit PCM audio.
 */

import type { TTSProvider } from './tts-provider.interface';
import type { TTSAudioResult, TTSOptions } from '../../types/dj-commentary';

export class LocalTTSProvider implements TTSProvider {
  readonly id = 'local-tts';
  readonly name = 'Local Offline Speech Synthesizer';

  private readonly availableVoices = ['Gakki-Local-Default', 'Gakki-Local-Warm', 'Gakki-Local-Radio'];

  async isAvailable(): Promise<boolean> {
    return true;
  }

  getAvailableVoices(): string[] {
    return [...this.availableVoices];
  }

  async synthesize(text: string, options: TTSOptions = {}): Promise<TTSAudioResult> {
    const startTime = Date.now();
    const sampleRate = options.sampleRate ?? 24000;
    const words = text.trim().split(/\s+/).length;

    // Approximate speaking rate: ~150 words per minute = 2.5 words/sec
    // 0.4s per word + 0.3s base padding
    const durationSeconds = Math.max(0.8, words * 0.38 + 0.3);
    const totalSamples = Math.floor(sampleRate * durationSeconds);
    const pcmBuffer = Buffer.alloc(totalSamples * 2); // 16-bit mono PCM

    // Synthesize harmonic formant tones modulated to speech rhythm
    for (let i = 0; i < totalSamples; i++) {
      const t = i / sampleRate;
      // Fundamental pitch ~180Hz (warm DJ pitch), with slight natural vibrato
      const f0 = 180 + Math.sin(2 * Math.PI * 5 * t) * 6;
      // Formants
      const harmonic1 = Math.sin(2 * Math.PI * f0 * t) * 0.4;
      const harmonic2 = Math.sin(2 * Math.PI * (f0 * 2) * t) * 0.25;
      const harmonic3 = Math.sin(2 * Math.PI * (f0 * 3.5) * t) * 0.15;

      // Word envelope modulation (cadence)
      const wordEnvelope = 0.5 + 0.5 * Math.sin(2 * Math.PI * 3.5 * t);
      // Soft start/end fade
      const attack = Math.min(1.0, t / 0.05);
      const release = Math.min(1.0, (durationSeconds - t) / 0.05);
      const fade = attack * release;

      const sampleFloat = (harmonic1 + harmonic2 + harmonic3) * wordEnvelope * fade * 0.35;
      const sampleInt16 = Math.round(sampleFloat * 32767);
      pcmBuffer.writeInt16LE(Math.max(-32768, Math.min(32767, sampleInt16)), i * 2);
    }

    const latencyMs = Date.now() - startTime;

    return {
      audioBuffer: pcmBuffer,
      format: {
        sampleRate,
        channels: 1,
        bitDepth: 16,
        encoding: 'pcm_s16le',
      },
      durationSeconds,
      latencyMs,
      provider: this.id,
    };
  }
}
