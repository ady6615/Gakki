import { createLogger } from '../utils/logger';
import type { TranscriptionProvider } from './transcription.interface';
import { MockTranscriptionProvider } from './providers/mock-transcription.provider';
import { WhisperLocalProvider } from './providers/whisper-local.provider';

const logger = createLogger('transcription-registry');

export class TranscriptionProviderRegistry {
  private readonly providers = new Map<string, TranscriptionProvider>();
  private defaultProviderName: string = 'mock-transcription';

  constructor() {
    // Register default built-in providers
    this.registerProvider(new WhisperLocalProvider());
    this.registerProvider(new MockTranscriptionProvider());
  }

  registerProvider(provider: TranscriptionProvider, makeDefault = false): void {
    this.providers.set(provider.name, provider);
    logger.debug({ provider: provider.name }, '[TRANSCRIPTION] Registered provider');
    if (makeDefault) {
      this.defaultProviderName = provider.name;
    }
  }

  register(provider: TranscriptionProvider, makeDefault = false): void {
    this.registerProvider(provider, makeDefault);
  }

  getProvider(name?: string): TranscriptionProvider | null {
    if (name && this.providers.has(name)) {
      return this.providers.get(name)!;
    }
    return this.providers.get(this.defaultProviderName) || null;
  }

  /**
   * Get the best available active provider.
   */
  async getBestAvailableProvider(): Promise<TranscriptionProvider> {
    // Check whisper local first
    const whisper = this.providers.get('whisper-local');
    if (whisper) {
      try {
        const available = await whisper.isAvailable();
        if (available) return whisper;
      } catch {
        // Fall back
      }
    }

    // Default to mock/offline provider
    return this.providers.get('mock-transcription') || new MockTranscriptionProvider();
  }

  getAllProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  getAvailableProviders(): string[] {
    return this.getAllProviders();
  }
}
