import { useEffect, useState } from 'react';

export interface LyricLine {
  timeMs: number;
  text: string;
}

export interface LyricsResponse {
  lyrics: string;
  synced: boolean;
  lines?: LyricLine[];
  providerName?: string;
  sourceAttribution?: string;
  confidence?: number;
}

interface LyricsPanelProps {
  trackTitle?: string | null;
  trackArtist?: string | null;
  trackDuration?: number | null;
  trackId?: string | null;
  isPlaying?: boolean;
}

export function LyricsPanel({
  trackTitle,
  trackArtist,
  trackDuration,
  trackId,
  isPlaying = false,
}: LyricsPanelProps) {
  const [lyricsData, setLyricsData] = useState<LyricsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Synced playback position (seconds)
  const [currentPositionSec, setCurrentPositionSec] = useState(0);
  const [activeLineIndex, setActiveLineIndex] = useState(-1);

  // Fetch lyrics when track changes
  useEffect(() => {
    if (!trackTitle && !trackId) {
      setLyricsData(null);
      return;
    }

    let isMounted = true;
    setLoading(true);
    setError(null);
    setCurrentPositionSec(0);
    setActiveLineIndex(-1);

    const queryParams = new URLSearchParams();
    if (trackTitle) queryParams.set('title', trackTitle);
    if (trackArtist) queryParams.set('artist', trackArtist);
    if (trackDuration) queryParams.set('duration', String(trackDuration));
    if (trackId) queryParams.set('trackId', trackId);

    fetch(`/api/lyrics?${queryParams.toString()}`)
      .then(async (res) => {
        if (!res.ok) {
          if (res.status === 404) return null;
          throw new Error('Failed to fetch lyrics');
        }
        return res.json();
      })
      .then((data) => {
        if (!isMounted) return;
        if (!data) {
          setLyricsData(null);
          setLoading(false);
          return;
        }

        // Defensive normalization for flat, nested, or legacy formats
        const plain =
          typeof data.lyrics === 'string'
            ? data.lyrics
            : typeof data.plainLyrics === 'string'
            ? data.plainLyrics
            : typeof data.lyrics?.plainLyrics === 'string'
            ? data.lyrics.plainLyrics
            : typeof data.data?.plainLyrics === 'string'
            ? data.data.plainLyrics
            : '';

        const isSynced = Boolean(
          data.synced ?? data.isSynced ?? data.lyrics?.isSynced ?? data.data?.isSynced
        );

        const lines = Array.isArray(data.lines)
          ? data.lines
          : Array.isArray(data.syncedLyrics)
          ? data.syncedLyrics
          : Array.isArray(data.lyrics?.syncedLyrics)
          ? data.lyrics.syncedLyrics
          : Array.isArray(data.data?.syncedLyrics)
          ? data.data.syncedLyrics
          : [];

        setLyricsData({
          lyrics: plain,
          synced: isSynced && lines.length > 0,
          lines,
          providerName: data.providerName || data.lyrics?.providerName || data.data?.providerName,
          sourceAttribution:
            data.sourceAttribution || data.lyrics?.sourceAttribution || data.data?.sourceAttribution,
          confidence: data.confidence ?? data.lyrics?.confidence ?? data.data?.confidence,
        });
        setLoading(false);
      })
      .catch((err) => {
        if (!isMounted) return;
        setError(err.message);
        setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [trackTitle, trackArtist, trackDuration, trackId]);

  // Interpolate playback position when playing
  useEffect(() => {
    if (!isPlaying) return;
    const interval = setInterval(() => {
      setCurrentPositionSec((prev) => {
        if (trackDuration && prev >= trackDuration) return prev;
        return prev + 0.5;
      });
    }, 500);

    return () => clearInterval(interval);
  }, [isPlaying, trackDuration]);

  // Listen to WebSocket position updates if available
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'playback.position' && typeof msg.positionSeconds === 'number') {
            setCurrentPositionSec(msg.positionSeconds);
          }
        } catch {
          // ignore
        }
      };
    } catch {
      // ignore
    }
    return () => {
      if (ws) ws.close();
    };
  }, [trackTitle]);

  // Find active lyric line based on current position
  useEffect(() => {
    if (!lyricsData?.synced || !lyricsData.lines || lyricsData.lines.length === 0) {
      setActiveLineIndex(-1);
      return;
    }

    const currentMs = currentPositionSec * 1000;
    const lines = lyricsData.lines;

    // Find the latest line whose timestamp is <= currentMs + 200ms grace window
    let idx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].timeMs <= currentMs + 200) {
        idx = i;
      } else {
        break;
      }
    }
    setActiveLineIndex(idx);
  }, [currentPositionSec, lyricsData]);

  const lines = lyricsData?.lines || [];
  const prevLine = activeLineIndex > 0 ? lines[activeLineIndex - 1]?.text : null;
  const currentLine = activeLineIndex >= 0 ? lines[activeLineIndex]?.text : null;
  const nextLine =
    activeLineIndex >= 0 && activeLineIndex < lines.length - 1
      ? lines[activeLineIndex + 1]?.text
      : null;

  return (
    <section className="lyrics-panel glass-panel" aria-label="Synchronized Song Lyrics">
      {/* Header */}
      <div className="lyrics-header">
        <div className="lyrics-header-left">
          <h3 className="lyrics-title">
            <span className="lyrics-icon">🎤</span> Lyrics Focus
          </h3>
          {lyricsData && (
            <span className="lyrics-badge">
              {lyricsData.synced ? '⚡ Synced Live' : '📄 Plain Text'}
              {lyricsData.providerName && ` • ${lyricsData.providerName}`}
              {lyricsData.confidence != null && ` (${Math.round(lyricsData.confidence * 100)}% match)`}
            </span>
          )}
        </div>
      </div>

      {loading && (
        <div className="lyrics-loading">
          <span className="spinner-icon">🔄</span> Searching lyrics...
        </div>
      )}

      {error && !loading && (
        <div className="lyrics-error">
          <span>⚠️ {error}</span>
        </div>
      )}

      {!loading && !error && !lyricsData && (
        <div className="lyrics-unavailable">
          <p className="unavailable-text">Lyrics unavailable.</p>
          <small>No lyrics found matching title and artist.</small>
        </div>
      )}

      {/* Synchronized 3-line Excerpt Focus View (Upper Section) */}
      {!loading && lyricsData?.synced && lines.length > 0 && (
        <div className="synced-focus-stage" aria-live="polite">
          <div className="focus-line prev-line">{prevLine || '...'}</div>
          <div className="focus-line current-line-highlight">
            {currentLine || (activeLineIndex === -1 ? '♪ (Intro) ♪' : '...')}
          </div>
          <div className="focus-line next-line">{nextLine || '...'}</div>
        </div>
      )}

      {/* Plain text preview for unsynced tracks (Upper Section) */}
      {!loading && lyricsData && !lyricsData.synced && lyricsData.lyrics && (
        <div className="synced-focus-stage plain-focus-stage" aria-live="polite">
          <div className="plain-lyrics-preview">
            {lyricsData.lyrics
              .split('\n')
              .filter((l) => l.trim().length > 0)
              .slice(0, 4)
              .map((line, idx) => (
                <div key={idx} className={`focus-line ${idx === 0 ? 'current-line-highlight' : ''}`}>
                  {line}
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Source Attribution */}
      {lyricsData?.sourceAttribution && !loading && (
        <div className="lyrics-attribution">
          Source: {lyricsData.sourceAttribution}
        </div>
      )}
    </section>
  );
}
