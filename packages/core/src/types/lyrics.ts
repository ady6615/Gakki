export interface LyricsLine {
  timeMs: number;
  text: string;
}

export interface LyricsResult {
  trackId?: string;
  plainLyrics: string;
  syncedLyrics?: LyricsLine[];
  isSynced: boolean;
  providerName: string;
  sourceAttribution?: string;
  confidence: number;
  cachedAt?: string;
}

export interface TrackMetadataForLyrics {
  title: string;
  artist?: string | null;
  album?: string | null;
  duration?: number | null;
}

export interface LyricsProvider {
  name: string;
  search(track: TrackMetadataForLyrics): Promise<LyricsResult | null>;
}
