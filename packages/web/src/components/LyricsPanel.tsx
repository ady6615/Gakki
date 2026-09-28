import { useEffect, useState, useRef } from 'react';

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
  const [autoScroll, setAutoScroll] = useState(true);

  const containerRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<(HTMLDivElement | null)[]>([]);
  const isUserScrollingRef = useRef(false);

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
    setAutoScroll(true);

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
        setLyricsData(data);
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

  // Find active lyric line based on current position
  useEffect(() => {
    if (!lyricsData?.synced || !lyricsData.lines || lyricsData.lines.length === 0) {
      setActiveLineIndex(-1);
      return;
    }

    const currentMs = currentPositionSec * 1000;
    const lines = lyricsData.lines;

    // Find the latest line whose timestamp is <= currentMs
    let idx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].timeMs <= currentMs + 200) {
        idx = i;
      } else {
        break;
      }
    }

    if (idx !== activeLineIndex) {
      setActiveLineIndex(idx);
    }
  }, [currentPositionSec, lyricsData, activeLineIndex]);

  // Auto-scroll to active line if autoScroll is enabled
  useEffect(() => {
    if (!autoScroll || activeLineIndex < 0) return;
    const targetEl = lineRefs.current[activeLineIndex];
    if (targetEl && containerRef.current) {
      targetEl.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }
  }, [activeLineIndex, autoScroll]);

  // Detect manual user scroll to pause auto-scroll (Requirement 5)
  const handleScroll = () => {
    if (!containerRef.current) return;
    // If the user triggered the scroll manually, disable auto-scroll
    if (!isUserScrollingRef.current) {
      // This allows user to freely read ahead without screen jumping back
      setAutoScroll(false);
    }
  };

  const resumeSync = () => {
    setAutoScroll(true);
    if (activeLineIndex >= 0 && lineRefs.current[activeLineIndex]) {
      lineRefs.current[activeLineIndex]?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }
  };

  // Jump position when clicking a lyric line
  const handleLineClick = (index: number) => {
    if (lyricsData?.lines && lyricsData.lines[index]) {
      const lineMs = lyricsData.lines[index].timeMs;
      setCurrentPositionSec(lineMs / 1000);
      setActiveLineIndex(index);
      setAutoScroll(true);
    }
  };

  const lines = lyricsData?.lines || [];
  const prevLine = activeLineIndex > 0 ? lines[activeLineIndex - 1]?.text : null;
  const currentLine = activeLineIndex >= 0 ? lines[activeLineIndex]?.text : null;
  const nextLine = activeLineIndex >= 0 && activeLineIndex < lines.length - 1 ? lines[activeLineIndex + 1]?.text : null;

  return (
    <section className="lyrics-panel glass-panel" aria-label="Synchronized Song Lyrics">
      <div className="lyrics-header">
        <div className="lyrics-header-left">
          <h3 className="lyrics-title">
            <span className="lyrics-icon">🎤</span> Lyrics
          </h3>
          {lyricsData && (
            <span className="lyrics-badge">
              {lyricsData.synced ? '⚡ Synced' : '📄 Plain Text'}
              {lyricsData.providerName && ` • ${lyricsData.providerName}`}
              {lyricsData.confidence != null && ` (${Math.round(lyricsData.confidence * 100)}% match)`}
            </span>
          )}
        </div>

        {lyricsData?.synced && !autoScroll && (
          <button
            className="resume-sync-btn"
            onClick={resumeSync}
            aria-label="Resume synchronized auto-scroll"
          >
            ▶ Resume Auto-Scroll
          </button>
        )}
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

      {/* Synchronized 3-line Excerpt Focus View (Requirement 3 & 5) */}
      {!loading && lyricsData?.synced && lines.length > 0 && (
        <div className="synced-focus-stage" aria-live="polite">
          <div className="focus-line prev-line">{prevLine || '...'}</div>
          <div className="focus-line current-line-highlight">
            {currentLine || (activeLineIndex === -1 ? '♪ (Intro) ♪' : '...')}
          </div>
          <div className="focus-line next-line">{nextLine || '...'}</div>
        </div>
      )}

      {/* Full Lyrics View */}
      {!loading && lyricsData && (
        <div
          className="lyrics-scroll-box"
          ref={containerRef}
          onScroll={handleScroll}
          tabIndex={0}
          role="region"
          aria-label="Full lyrics text"
        >
          {lyricsData.synced && lines.length > 0 ? (
            <div className="synced-lines-container">
              {lines.map((line, idx) => {
                const isActive = idx === activeLineIndex;
                const isPast = idx < activeLineIndex;
                return (
                  <div
                    key={`${line.timeMs}-${idx}`}
                    ref={(el) => (lineRefs.current[idx] = el)}
                    className={`lyric-line ${isActive ? 'active' : ''} ${isPast ? 'past' : ''}`}
                    onClick={() => handleLineClick(idx)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') handleLineClick(idx);
                    }}
                    aria-label={`${line.text} at ${Math.floor(line.timeMs / 1000)} seconds`}
                  >
                    <span className="line-time">
                      {Math.floor(line.timeMs / 60000)}:
                      {Math.floor((line.timeMs % 60000) / 1000).toString().padStart(2, '0')}
                    </span>
                    <span className="line-text">{line.text || '♪ ♪ ♪'}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="plain-lyrics-view">
              <pre className="plain-lyrics-content">{lyricsData.lyrics}</pre>
            </div>
          )}

          {lyricsData.sourceAttribution && (
            <div className="lyrics-attribution">
              Source: {lyricsData.sourceAttribution}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
