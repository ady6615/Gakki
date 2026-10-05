/**
 * Modular TTS Provider Interface
 *
 * Implements Requirement 17:
 * Keep TTS provider-independent (Gemini TTS, Local TTS, Edge/Whisper TTS).
 */

import type { TTSAudioResult, TTSOptions } from '../../types/dj-commentary';

export interface TTSProvider {
  readonly id: string;
  readonly name: string;

  /**
   * Synthesize commentary text into an audio buffer.
   */
  synthesize(text: string, options?: TTSOptions): Promise<TTSAudioResult>;

  /**
   * Check if this TTS provider is available (API key configured, network ready, etc.).
   */
  isAvailable(): Promise<boolean>;

  /**
   * List available voice profiles for this provider.
   */
  getAvailableVoices(): string[];
}
