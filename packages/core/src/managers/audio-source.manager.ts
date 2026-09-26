import type {
  MusicSourceProvider,
  MusicSearchProvider,
  ResolvedTrack,
  TrackMetadata,
  SearchResult,
  SearchOptions,
} from '../types/source';
import type { TrackManager } from './track.manager';
import { createLogger } from '../utils/logger';

const logger = createLogger('audio-source-manager');

/**
 * Coordinates audio source providers, input resolution, metadata extraction,
 * and track persistence.
 */
export class AudioSourceManager {
  private readonly providers: MusicSourceProvider[] = [];
  private readonly searchProviders: MusicSearchProvider[] = [];

  constructor(private readonly trackManager?: TrackManager) {}

  /**
   * Register an audio source provider.
   */
  registerProvider(provider: MusicSourceProvider): this {
    this.providers.push(provider);
    logger.debug({ provider: provider.name }, 'Registered audio source provider');
    return this;
  }

  /**
   * Register a search provider.
   */
  registerSearchProvider(provider: MusicSearchProvider): this {
    this.searchProviders.push(provider);
    logger.debug({ provider: provider.name }, 'Registered search provider');
    return this;
  }

  /**
   * Check if any registered provider can handle the input.
   */
  canHandle(input: string): boolean {
    return this.providers.some((p) => p.canHandle(input));
  }

  /**
   * Find the matching provider for an input.
   */
  getProviderFor(input: string): MusicSourceProvider | undefined {
    return this.providers.find((p) => p.canHandle(input));
  }

  /**
   * Resolve an input (file name, URL, query) to a playable ResolvedTrack.
   */
  async resolve(input: string): Promise<ResolvedTrack> {
    const trimmed = input.trim();
    const provider = this.getProviderFor(trimmed);

    if (!provider) {
      throw new Error(`Unsupported audio input or no provider available: "${trimmed}"`);
    }

    logger.info(
      { provider: provider.name, input: trimmed },
      '[SOURCE] Resolving: %s via %s',
      trimmed,
      provider.name,
    );

    const resolved = await provider.resolve(trimmed);

    logger.info(
      {
        provider: provider.name,
        title: resolved.title,
        duration: resolved.metadata.duration,
        sourceType: resolved.source.sourceType,
      },
      '[SOURCE] Resolved: %s',
      resolved.title,
    );

    // Persist to PostgreSQL if trackManager is present
    if (this.trackManager) {
      try {
        const saved = await this.trackManager.saveTrackWithSource(resolved.metadata, resolved.source);
        resolved.id = saved.track.id;
      } catch (err) {
        logger.warn({ err, title: resolved.title }, 'Could not persist track to database — continuing runtime playback');
      }
    }

    return resolved;
  }

  /**
   * Search across all registered search providers.
   */
  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const limit = options.limit ?? 5;
    const results: SearchResult[] = [];

    for (const searchProvider of this.searchProviders) {
      try {
        const found = await searchProvider.search(query, { ...options, limit });
        results.push(...found);
        if (results.length >= limit) {
          break;
        }
      } catch (err) {
        logger.warn({ err, provider: searchProvider.name, query }, 'Search provider failed');
      }
    }

    return results.slice(0, limit);
  }
}
