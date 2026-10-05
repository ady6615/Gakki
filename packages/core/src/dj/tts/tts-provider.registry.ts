/**
 * TTS Provider Registry
 *
 * Implements Requirement 17:
 * Keep TTS provider-independent and allow dynamic fallback selection.
 */

import type { TTSProvider } from './tts-provider.interface';
import { LocalTTSProvider } from './local-tts.provider';
import { GeminiTTSProvider } from './gemini-tts.provider';
import { createLogger } from '../../utils/logger';

const logger = createLogger('tts-registry');

export class TTSProviderRegistry {
  private readonly providers = new Map<string, TTSProvider>();
  private defaultProviderId = 'local-tts';

  constructor() {
    this.registerProvider(new LocalTTSProvider());
    this.registerProvider(new GeminiTTSProvider());
  }

  registerProvider(provider: TTSProvider): void {
    this.providers.set(provider.id, provider);
    logger.debug({ id: provider.id, name: provider.name }, 'Registered TTS provider');
  }

  setDefaultProvider(providerId: string): void {
    if (this.providers.has(providerId)) {
      this.defaultProviderId = providerId;
    }
  }

  getProvider(providerId?: string): TTSProvider {
    const id = providerId || this.defaultProviderId;
    const provider = this.providers.get(id);
    if (provider) return provider;

    const fallback = this.providers.get('local-tts');
    if (fallback) return fallback;

    return new LocalTTSProvider();
  }

  async getAvailableProviders(): Promise<Array<{ id: string; name: string; available: boolean }>> {
    const results: Array<{ id: string; name: string; available: boolean }> = [];
    for (const provider of this.providers.values()) {
      const available = await provider.isAvailable();
      results.push({
        id: provider.id,
        name: provider.name,
        available,
      });
    }
    return results;
  }
}
