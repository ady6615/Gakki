/**
 * Audio source provider abstraction and metadata types.
 */

export interface TrackChapter {
  title: string;
  startTime: number; // in seconds
  endTime: number; // in seconds
}

/**
 * Normalized rich metadata for a music track.
 * Missing metadata is handled with null/undefined without inventing values.
 */
export interface TrackMetadata {
  title: string;
  artist?: string | null;
  album?: string | null;
  albumArtist?: string | null;
  duration?: number | null; // duration in seconds
  genre?: string | null;
  year?: number | null;
  trackNumber?: number | null;
  thumbnailUrl?: string | null;
  coverArtPath?: string | null;
  chapters?: TrackChapter[];
}

/**
 * Metadata about the audio source location and provider.
 */
export interface TrackSourceInfo {
  provider: string; // e.g. 'local', 'http_stream', 'soundcloud', 'youtube'
  sourceType: 'file' | 'stream' | 'url';
  sourceUrl: string; // Permanent or stable reference, never temporary tokens
  externalId?: string | null;
  isEphemeral?: boolean; // If true, stream must not be permanently cached
}

/**
 * Unified resolved track returned by audio source providers.
 */
export interface ResolvedTrack {
  id?: string;
  title: string;
  metadata: TrackMetadata;
  source: TrackSourceInfo;
  streamUrlOrPath: string; // Local path or direct HTTP stream URL for FFmpeg
  headers?: Record<string, string>;
  isStream?: boolean;
}

/**
 * Standard search result item for /search.
 */
export interface SearchResult {
  title: string;
  artist?: string | null;
  album?: string | null;
  duration?: number | null;
  provider: string;
  sourceUrl: string;
  thumbnailUrl?: string | null;
  externalId?: string | null;
}

export interface SearchOptions {
  limit?: number;
  offset?: number;
}

/**
 * Provider-based audio source interface.
 * Decouples music resolution from playback engine.
 */
export interface MusicSourceProvider {
  readonly name: string;

  /**
   * Check whether this provider can handle the given input.
   */
  canHandle(input: string): boolean;

  /**
   * Resolve input into a playable ResolvedTrack with normalized metadata.
   */
  resolve(input: string): Promise<ResolvedTrack>;

  /**
   * Extract or query rich metadata for the input.
   */
  getMetadata(input: string): Promise<TrackMetadata>;
}

/**
 * Provider-independent search provider interface.
 */
export interface MusicSearchProvider {
  readonly name: string;

  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
}
