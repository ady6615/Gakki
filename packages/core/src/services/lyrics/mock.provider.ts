import type { LyricsProvider, LyricsResult, TrackMetadataForLyrics } from '../../types/lyrics';
import { parseLrcLyrics } from '../../utils/lrc-parser';
import { computeLyricsMatchConfidence } from '../../utils/lyrics-matcher';

export interface MockSongLyricsEntry {
  title: string;
  artist?: string;
  album?: string;
  duration?: number;
  plainLyrics: string;
  lrcLyrics?: string;
  attribution?: string;
}

export class MockLyricsProvider implements LyricsProvider {
  readonly name: string;
  private readonly catalog: MockSongLyricsEntry[] = [];
  public shouldFail: boolean = false;

  constructor(name: string = 'mock', initialEntries?: MockSongLyricsEntry[]) {
    this.name = name;
    if (initialEntries) {
      this.catalog.push(...initialEntries);
    } else {
      // Add standard test tracks
      this.catalog.push({
        title: 'After Dark',
        artist: 'Mr.Kitty',
        album: 'Time',
        duration: 257,
        plainLyrics: `I see you standing there
Waiting for the morning sun
Another day begins
Where have all the shadows gone?`,
        lrcLyrics: `[00:10.00] I see you standing there
[00:15.50] Waiting for the morning sun
[00:20.00] Another day begins
[00:26.50] Where have all the shadows gone?`,
        attribution: 'Mock Provider Test Catalog',
      });

      this.catalog.push({
        title: 'Resonance',
        artist: 'HOME',
        album: 'Odyssey',
        duration: 212,
        plainLyrics: '[Instrumental]',
        attribution: 'Mock Provider Test Catalog',
      });

      this.catalog.push({
        title: 'Long Song',
        artist: 'Epic Artist',
        plainLyrics: Array(50)
          .fill(0)
          .map((_, i) => `Verse line ${i + 1}: Singing this long epic ballad of harmony and rhythm.`)
          .join('\n'),
        attribution: 'Mock Provider Long Song',
      });
    }
  }

  addEntry(entry: MockSongLyricsEntry): void {
    this.catalog.push(entry);
  }

  async search(track: TrackMetadataForLyrics): Promise<LyricsResult | null> {
    if (this.shouldFail) {
      throw new Error(`Provider ${this.name} simulated failure`);
    }

    if (!track.title) return null;

    let bestMatch: MockSongLyricsEntry | null = null;
    let bestScore = 0;

    for (const item of this.catalog) {
      const score = computeLyricsMatchConfidence(track, {
        trackName: item.title,
        artistName: item.artist,
        albumName: item.album,
        duration: item.duration,
      });

      if (score > bestScore) {
        bestScore = score;
        bestMatch = item;
      }
    }

    if (!bestMatch || bestScore < 0.4) {
      return null;
    }

    const parsedSynced = bestMatch.lrcLyrics ? parseLrcLyrics(bestMatch.lrcLyrics) : undefined;

    return {
      plainLyrics: bestMatch.plainLyrics,
      syncedLyrics: parsedSynced && parsedSynced.length > 0 ? parsedSynced : undefined,
      isSynced: Boolean(parsedSynced && parsedSynced.length > 0),
      providerName: this.name,
      sourceAttribution: bestMatch.attribution || 'Mock Provider',
      confidence: bestScore,
    };
  }
}
