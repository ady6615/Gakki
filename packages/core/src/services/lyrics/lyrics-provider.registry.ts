import type { LyricsProvider, LyricsResult, TrackMetadataForLyrics } from '../../types/lyrics';
import { createLogger } from '../../utils/logger';

const logger = createLogger('lyrics-provider-registry');

export class LyricsProviderRegistry {
  private providers: LyricsProvider[] = [];

  register(provider: LyricsProvider): void {
    const existing = this.providers.find((p) => p.name === provider.name);
    if (existing) {
      this.unregister(provider.name);
    }
    this.providers.push(provider);
    logger.info({ provider: provider.name }, 'Registered lyrics provider');
  }

  unregister(providerName: string): boolean {
    const initialLen = this.providers.length;
    this.providers = this.providers.filter((p) => p.name !== providerName);
    return this.providers.length < initialLen;
  }

  getProviders(): LyricsProvider[] {
    return [...this.providers];
  }

  getProvider(name: string): LyricsProvider | undefined {
    return this.providers.find((p) => p.name === name);
  }

  /**
   * Search across all registered providers in order.
   * If a provider throws or returns null, attempts next provider.
   */
  async search(track: TrackMetadataForLyrics): Promise<LyricsResult | null> {
    for (const provider of this.providers) {
      try {
        const result = await provider.search(track);
        if (result && result.plainLyrics && result.plainLyrics.trim().length > 0) {
          logger.debug({ provider: provider.name, title: track.title, confidence: result.confidence }, 'Lyrics resolved');
          return result;
        }
      } catch (err: any) {
        logger.warn({ provider: provider.name, err: err?.message || String(err) }, 'Lyrics provider failed, trying next');
      }
    }
    return null;
  }
}
