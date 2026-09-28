import type { Track } from './track';
import type { Playlist } from './playlist';
import type { AcousticFeatures } from './recommendation';

export interface LibrarySearchResult {
  tracks: Track[];
  artists: { name: string; trackCount: number }[];
  albums: { name: string; artist: string | null; trackCount: number }[];
  playlists: Playlist[];
}

export interface TrackDetails {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  duration: number | null;
  coverArt: string | null;
  sources: Array<{
    provider: string;
    sourceType: string;
    sourceUrl: string;
  }>;
  audioFeatures?: AcousticFeatures | null;
  analytics?: {
    playCount: number;
    completionRate: number;
    skipRate: number;
    totalListeningSeconds: number;
  };
  similarTracks?: Track[];
}

export interface AnalyticsDashboardStats {
  totalPlays: number;
  totalListeningSeconds: number;
  completionRate: number;
  skipRate: number;
  topTracks: Array<{
    trackId: string;
    title: string;
    artist: string | null;
    playCount: number;
    duration: number | null;
  }>;
  mostPlayedTracks: Array<{
    trackId: string;
    title: string;
    artist: string | null;
    playCount: number;
    duration: number | null;
  }>;
  topArtists: Array<{
    artist: string;
    playCount: number;
  }>;
  topListeners?: Array<{
    userId: string;
    playCount: number;
    durationSeconds: number;
  }>;
  mostActiveListeners?: Array<{
    userId: string;
    playCount: number;
    durationSeconds: number;
  }>;
  timeRange: 'today' | '7d' | '30d' | 'all';
}
