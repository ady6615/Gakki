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
