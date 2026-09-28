import type { LyricsLine } from '../types/lyrics';

/**
 * Parses raw LRC format lyrics into an ordered array of timestamped lines.
 * Example LRC input:
 * [00:15.20] Hello world
 * [00:18.50] Next line of lyrics
 */
export function parseLrcLyrics(lrcText: string): LyricsLine[] {
  if (!lrcText || typeof lrcText !== 'string') {
    return [];
  }

  const lines = lrcText.split(/\r?\n/);
  const result: LyricsLine[] = [];
  const timeRegex = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    timeRegex.lastIndex = 0;
    const matches: Array<{ minutes: number; seconds: number; millis: number }> = [];
    let match: RegExpExecArray | null;

    while ((match = timeRegex.exec(trimmed)) !== null) {
      const minutes = parseInt(match[1], 10);
      const seconds = parseInt(match[2], 10);
      let millis = 0;
      if (match[3]) {
        millis = parseInt(match[3].padEnd(3, '0').slice(0, 3), 10);
      }
      matches.push({ minutes, seconds, millis });
    }

    if (matches.length === 0) continue;

    const text = trimmed.replace(/\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]/g, '').trim();

    for (const m of matches) {
      const timeMs = (m.minutes * 60 + m.seconds) * 1000 + m.millis;
      result.push({ timeMs, text });
    }
  }

  // Sort chronologically by timeMs
  result.sort((a, b) => a.timeMs - b.timeMs);

  return result;
}

/**
 * Finds the active lyrics index for the given playback position in milliseconds.
 * Returns -1 if playback position is before the first lyric line.
 */
export function findActiveLyricLineIndex(lines: LyricsLine[], positionMs: number): number {
  if (!lines || lines.length === 0) return -1;
  if (positionMs < lines[0].timeMs) return -1;

  for (let i = lines.length - 1; i >= 0; i--) {
    if (positionMs >= lines[i].timeMs) {
      return i;
    }
  }

  return 0;
}
