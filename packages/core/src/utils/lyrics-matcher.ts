import type { TrackMetadataForLyrics } from '../types/lyrics';

/**
 * Normalizes title / artist string for comparison by removing punctuation,
 * tags like (Official Video), (feat. ...), [Remastered], etc.
 */
export function normalizeSongString(str: string): string {
  if (!str) return '';
  return str
    .toLowerCase()
    .replace(/\((?:official\s+(?:video|audio|music\s+video)|feat\.?|ft\.?|lyrics|remastered|hd|4k)[^)]*\)/gi, '')
    .replace(/\[(?:official\s+(?:video|audio|music\s+video)|feat\.?|ft\.?|lyrics|remastered|hd|4k)[^\]]*\]/gi, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface CleanedTrackMetadata {
  title: string;
  artist?: string;
  album?: string;
  duration?: number;
  searchQuery: string;
}

/**
 * Sanitizes raw titles (e.g. from YouTube, local filenames, or dirty metadata):
 * - Strips file extensions (.mp3, .flac, etc.)
 * - Strips track numbers at start (01 -, 01. )
 * - Strips YouTube/MV bracketed tags [Official Music Video], (Lyrics), etc.
 * - Extracts "Artist - Title" if artist is omitted
 */
export function cleanTrackMetadata(track: TrackMetadataForLyrics): CleanedTrackMetadata {
  let rawTitle = (track.title || '').trim();
  let artist = (track.artist || '').trim();
  const album = (track.album || '').trim();
  const duration = track.duration && track.duration > 0 ? track.duration : undefined;

  // 1. Strip file extensions
  let title = rawTitle.replace(/\.(mp3|wav|flac|m4a|ogg|opus|aac|webm|wma)$/i, '');

  // 2. Strip leading track numbering e.g. "01 - ", "01. "
  title = title.replace(/^(\d{1,3}[\s.\-_]+)+/, '');

  // 3. Strip common video/audio suffixes & bracketed tags
  title = title
    .replace(/\s*[\(\[]\s*(?:official\s+(?:music\s+)?video|official\s+audio|official|lyrics?|lyric\s+video|visualizer|audio|audio\s+track|mv|hd|4k|remaster(?:ed)?(?:\s+\d+)?|live(?:\s+at[^)\]]*)?|cover|slowed(?:\s+\+\s+reverb)?|sped\s+up|full\s+song)[\)\]]/gi, '')
    .replace(/\s*[\(\[]\s*(?:320\s*kbps|flac|hq|1080p|720p)[\)\]]/gi, '');

  // 4. Handle "Artist - Title" pattern
  const dashMatch = title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (dashMatch) {
    const part1 = dashMatch[1].trim();
    const part2 = dashMatch[2].trim();
    if (!artist) {
      artist = part1;
      title = part2;
    } else if (artist.toLowerCase() === part1.toLowerCase() || part1.toLowerCase().includes(artist.toLowerCase())) {
      title = part2;
    }
  }

  // 5. Remove featured artists from title if present (e.g. "Song (feat. Artist)" or "Song ft. Artist")
  title = title
    .replace(/\s*[\(\[]\s*(?:feat\.?|ft\.?)\s+[^)\]]+[\)\]]/gi, '')
    .replace(/\s+(?:feat\.?|ft\.?)\s+.+$/i, '');

  // 6. Clean quotes, brackets, and extra spaces
  title = title.replace(/["'“”]/g, '').replace(/\s+/g, ' ').trim() || rawTitle;
  artist = artist.replace(/["'“”]/g, '').replace(/\s+/g, ' ').trim();

  const searchQuery = [artist, title].filter(Boolean).join(' ').trim();

  return {
    title,
    artist: artist || undefined,
    album: album || undefined,
    duration,
    searchQuery,
  };
}

/**
 * Calculate similarity between two strings using bigram dice coefficient (0 to 1).
 */
export function stringSimilarity(a: string, b: string): number {
  const normA = normalizeSongString(a);
  const normB = normalizeSongString(b);

  if (normA === normB) return 1.0;
  if (!normA || !normB) return 0.0;
  if (normA.includes(normB) || normB.includes(normA)) return 0.85;

  const getBigrams = (s: string): Set<string> => {
    const bigrams = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) {
      bigrams.add(s.substring(i, i + 2));
    }
    return bigrams;
  };

  const bigramsA = getBigrams(normA);
  const bigramsB = getBigrams(normB);

  let intersection = 0;
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) intersection++;
  }

  return (2.0 * intersection) / (bigramsA.size + bigramsB.size);
}

export interface MatchCandidate {
  trackName: string;
  artistName?: string | null;
  albumName?: string | null;
  duration?: number | null; // in seconds
}

/**
 * Computes match confidence between track query and candidate result.
 * Returns score between 0.0 and 1.0.
 */
export function computeLyricsMatchConfidence(
  query: TrackMetadataForLyrics,
  candidate: MatchCandidate
): number {
  if (!query.title || !candidate.trackName) return 0.0;

  // 1. Title similarity (weight: 0.45)
  const titleScore = stringSimilarity(query.title, candidate.trackName);

  // If title similarity is too low, reject immediately
  if (titleScore < 0.4) {
    return 0.0;
  }

  // 2. Artist similarity (weight: 0.35)
  let artistScore = 0.5; // neutral if artist not specified
  if (query.artist && candidate.artistName) {
    artistScore = stringSimilarity(query.artist, candidate.artistName);
  } else if (!query.artist && !candidate.artistName) {
    artistScore = 0.5;
  }

  // If both artists provided and they mismatch significantly, heavily penalize
  if (query.artist && candidate.artistName && artistScore < 0.35) {
    return 0.15; // Unlikely to be the same song
  }

  // 3. Duration compatibility (weight: 0.20)
  let durationScore = 0.5; // neutral if duration unknown
  if (query.duration && candidate.duration && query.duration > 0 && candidate.duration > 0) {
    const diff = Math.abs(query.duration - candidate.duration);
    if (diff <= 3) {
      durationScore = 1.0;
    } else if (diff <= 8) {
      durationScore = 0.8;
    } else if (diff <= 15) {
      durationScore = 0.5;
    } else if (diff <= 30) {
      durationScore = 0.2;
    } else {
      durationScore = 0.0; // severe duration mismatch
    }
  }

  // 4. Album bonus (up to +0.05)
  let albumBonus = 0;
  if (query.album && candidate.albumName && stringSimilarity(query.album, candidate.albumName) > 0.7) {
    albumBonus = 0.05;
  }

  const confidence = titleScore * 0.45 + artistScore * 0.35 + durationScore * 0.20 + albumBonus;
  return Math.min(1.0, Math.max(0.0, Math.round(confidence * 100) / 100));
}
