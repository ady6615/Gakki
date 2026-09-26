import type {
  MusicSourceProvider,
  ResolvedTrack,
  TrackMetadata,
} from '@gakki/core';
import { createLogger } from '@gakki/core';

const logger = createLogger('youtube-provider');

export class ProviderPolicyRestrictionError extends Error {
  constructor(provider: string, policyNotice: string) {
    super(`[POLICY] Provider "${provider}" restriction: ${policyNotice}`);
    this.name = 'ProviderPolicyRestrictionError';
  }
}

/**
 * YouTube Source Provider enforcing strict Developer Policy Compliance.
 *
 * In accordance with YouTube Developer Policies and Terms of Service,
 * audio stream downloading, isolating, caching, or circumvention of playback
 * controls is strictly prohibited. This provider rejects ingestion requests
 * cleanly with an informative, compliant error message.
 */
export class YouTubeSourceProvider implements MusicSourceProvider {
  readonly name = 'youtube';

  canHandle(input: string): boolean {
    const lower = input.toLowerCase();
    return (
      lower.includes('youtube.com/') ||
      lower.includes('youtu.be/') ||
      lower.startsWith('ytsearch:')
    );
  }

  async getMetadata(input: string): Promise<TrackMetadata> {
    logger.warn({ input }, '[POLICY] Refusing YouTube metadata extraction due to Terms of Service restrictions');
    throw new ProviderPolicyRestrictionError(
      'YouTube',
      'Audio stream ingestion and caching are restricted by YouTube Developer Terms of Service. Please use an authorized direct audio stream, SoundCloud link, or local audio file.',
    );
  }

  async resolve(input: string): Promise<ResolvedTrack> {
    logger.warn({ input }, '[POLICY] Refusing YouTube resolution due to Terms of Service restrictions');
    throw new ProviderPolicyRestrictionError(
      'YouTube',
      'Audio stream ingestion and caching are restricted by YouTube Developer Terms of Service. Please use an authorized direct audio stream, SoundCloud link, or local audio file.',
    );
  }
}
