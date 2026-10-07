import { useState, useEffect, useCallback } from 'react';

export interface DashboardStats {
  timeRange: 'today' | '7d' | '30d' | 'all';
  totalPlays: number;
  totalListeningSeconds: number;
  completionRate: number;
  skipRate: number;
  mostPlayedTracks: Array<{
    trackId: string;
    title: string;
    artist?: string;
    playCount: number;
    completionRate?: number;
  }>;
  topArtists: Array<{
    artist: string;
    playCount: number;
  }>;
  mostActiveListeners: Array<{
    userId: string;
    playCount: number;
    totalListeningSeconds: number;
  }>;
}

interface AnalyticsDashboardProps {
  guildId?: string;
  onEnqueueTrack?: (trackName: string) => void;
}

function formatListeningTime(totalSeconds: number): string {
  if (!totalSeconds || isNaN(totalSeconds) || totalSeconds <= 0) return '0 min';
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

export function AnalyticsDashboard({ guildId, onEnqueueTrack }: AnalyticsDashboardProps) {
  const [timeRange, setTimeRange] = useState<'today' | '7d' | '30d' | 'all'>('7d');
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewScope, setViewScope] = useState<'server' | 'global' | 'user'>('server');
  const [queuedFeedback, setQueuedFeedback] = useState<string | null>(null);

  const fetchStats = useCallback(async () => {
    setLoading(true);
    setError(null);

    const queryParams = new URLSearchParams();
    queryParams.set('timeRange', timeRange);

    if (viewScope === 'server' && guildId && guildId !== 'web-dashboard') {
      queryParams.set('guildId', guildId);
    } else if (viewScope === 'user') {
      queryParams.set('userId', 'web-user');
    }
    // If viewScope === 'global', we don't set guildId or userId to get global stats

    try {
      const res = await fetch(`/api/analytics/dashboard?${queryParams.toString()}`);
      if (!res.ok) {
        throw new Error(`Analytics request failed (${res.status})`);
      }
      const data = await res.json();
      const raw = data?.stats || data;

      if (raw) {
        setStats({
          timeRange: raw.timeRange || timeRange,
          totalPlays: typeof raw.totalPlays === 'number' ? raw.totalPlays : Number(raw.totalPlays || 0),
          totalListeningSeconds: typeof raw.totalListeningSeconds === 'number' ? raw.totalListeningSeconds : Number(raw.totalListeningSeconds || 0),
          completionRate: typeof raw.completionRate === 'number' ? raw.completionRate : Number(raw.completionRate || 0),
          skipRate: typeof raw.skipRate === 'number' ? raw.skipRate : Number(raw.skipRate || 0),
          mostPlayedTracks: Array.isArray(raw.mostPlayedTracks)
            ? raw.mostPlayedTracks
            : Array.isArray(raw.topTracks)
            ? raw.topTracks
            : [],
          topArtists: Array.isArray(raw.topArtists) ? raw.topArtists : [],
          mostActiveListeners: Array.isArray(raw.mostActiveListeners)
            ? raw.mostActiveListeners
            : Array.isArray(raw.topListeners)
            ? raw.topListeners
            : [],
        });
      } else {
        setStats({
          timeRange,
          totalPlays: 0,
          totalListeningSeconds: 0,
          completionRate: 0,
          skipRate: 0,
          mostPlayedTracks: [],
          topArtists: [],
          mostActiveListeners: [],
        });
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load statistics');
      // Fallback empty stats so the page still renders cleanly
      setStats({
        timeRange,
        totalPlays: 0,
        totalListeningSeconds: 0,
        completionRate: 0,
        skipRate: 0,
        mostPlayedTracks: [],
        topArtists: [],
        mostActiveListeners: [],
      });
    } finally {
      setLoading(false);
    }
  }, [timeRange, viewScope, guildId]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  const handleQueueSong = async (trackTitle: string) => {
    if (!trackTitle) return;
    if (onEnqueueTrack) {
      onEnqueueTrack(trackTitle);
      setQueuedFeedback(`Queued: ${trackTitle}`);
      setTimeout(() => setQueuedFeedback(null), 3000);
      return;
    }

    const gid = guildId || 'default-guild';
    try {
      const res = await fetch(`/api/queue/${gid}/tracks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: [trackTitle], addedBy: 'Analytics Panel' }),
      });
      if (res.ok) {
        setQueuedFeedback(`Queued: ${trackTitle}`);
      } else {
        setQueuedFeedback(`Failed to queue: ${trackTitle}`);
      }
    } catch {
      setQueuedFeedback(`Error queueing: ${trackTitle}`);
    }
    setTimeout(() => setQueuedFeedback(null), 3000);
  };

  const cycleScope = () => {
    setViewScope((prev) => {
      if (prev === 'server') return 'global';
      if (prev === 'global') return 'user';
      return 'server';
    });
  };

  return (
    <section className="analytics-dashboard glass-panel" aria-label="Playback Analytics Dashboard">
      <div className="analytics-header">
        <div className="analytics-header-left">
          <h3 className="analytics-title">
            <span className="analytics-icon">📊</span> Statistics & Listening Analytics
          </h3>
          <button
            className="analytics-scope-pill"
            onClick={cycleScope}
            title="Click to toggle Server vs Global vs Personal listening scope"
          >
            {viewScope === 'server'
              ? '🌐 Server Scope'
              : viewScope === 'global'
              ? '🌍 Global Scope'
              : '👤 Personal Scope'}
          </button>
          <button
            className="analytics-refresh-btn"
            onClick={fetchStats}
            disabled={loading}
            title="Refresh statistics data"
            style={{
              background: 'rgba(255, 255, 255, 0.05)',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              color: '#cbd5e1',
              borderRadius: '6px',
              padding: '0.35rem 0.65rem',
              fontSize: '0.8rem',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.3rem',
            }}
          >
            🔄 {loading ? 'Loading...' : 'Refresh'}
          </button>
        </div>

        {/* Time-Range Selector Buttons */}
        <div className="time-range-button-group" role="group" aria-label="Analytics Time Range">
          <button
            className={`time-range-btn ${timeRange === 'today' ? 'active' : ''}`}
            onClick={() => setTimeRange('today')}
            aria-pressed={timeRange === 'today'}
          >
            Today
          </button>
          <button
            className={`time-range-btn ${timeRange === '7d' ? 'active' : ''}`}
            onClick={() => setTimeRange('7d')}
            aria-pressed={timeRange === '7d'}
          >
            7 Days
          </button>
          <button
            className={`time-range-btn ${timeRange === '30d' ? 'active' : ''}`}
            onClick={() => setTimeRange('30d')}
            aria-pressed={timeRange === '30d'}
          >
            30 Days
          </button>
          <button
            className={`time-range-btn ${timeRange === 'all' ? 'active' : ''}`}
            onClick={() => setTimeRange('all')}
            aria-pressed={timeRange === 'all'}
          >
            All Time
          </button>
        </div>
      </div>

      {queuedFeedback && (
        <div
          style={{
            background: 'rgba(16, 185, 129, 0.15)',
            border: '1px solid rgba(16, 185, 129, 0.3)',
            color: '#34d399',
            padding: '0.5rem 0.8rem',
            borderRadius: '6px',
            fontSize: '0.85rem',
          }}
        >
          ✓ {queuedFeedback}
        </div>
      )}

      {error && (
        <div
          style={{
            background: 'rgba(239, 68, 68, 0.12)',
            border: '1px solid rgba(239, 68, 68, 0.25)',
            color: '#f87171',
            padding: '0.6rem 0.9rem',
            borderRadius: '6px',
            fontSize: '0.85rem',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>⚠️ {error}</span>
          <button
            onClick={fetchStats}
            style={{
              background: 'transparent',
              border: '1px solid rgba(239, 68, 68, 0.4)',
              color: '#fff',
              padding: '0.2rem 0.5rem',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '0.75rem',
            }}
          >
            Retry
          </button>
        </div>
      )}

      {loading && !stats && (
        <div className="analytics-loading" style={{ textAlign: 'center', padding: '3rem 1rem', color: '#94a3b8' }}>
          <span className="spinner-icon">🔄</span> Calculating analytics...
        </div>
      )}

      {stats && (
        <div className="analytics-content">
          {/* 4 Stat Cards */}
          <div className="stats-kpi-grid">
            <div className="kpi-card glass-card">
              <span className="kpi-icon">▶️</span>
              <div className="kpi-data">
                <span className="kpi-value">{(stats.totalPlays ?? 0).toLocaleString()}</span>
                <span className="kpi-label">TOTAL PLAYS</span>
              </div>
            </div>

            <div className="kpi-card glass-card">
              <span className="kpi-icon">⏳</span>
              <div className="kpi-data">
                <span className="kpi-value">{formatListeningTime(stats.totalListeningSeconds ?? 0)}</span>
                <span className="kpi-label">LISTENING TIME</span>
              </div>
            </div>

            <div className="kpi-card glass-card">
              <span className="kpi-icon">🎯</span>
              <div className="kpi-data">
                <span className="kpi-value">{Math.round((stats.completionRate ?? 0) * 100)}%</span>
                <span className="kpi-label">COMPLETION RATE</span>
              </div>
            </div>

            <div className="kpi-card glass-card">
              <span className="kpi-icon">⏭️</span>
              <div className="kpi-data">
                <span className="kpi-value">{Math.round((stats.skipRate ?? 0) * 100)}%</span>
                <span className="kpi-label">SKIP RATE</span>
              </div>
            </div>
          </div>

          {/* Detailed Ranked Lists */}
          <div className="analytics-columns-grid">
            {/* Most Played Tracks */}
            <div className="analytics-panel-box glass-card">
              <h4 className="panel-box-title">🔥 Most Played Tracks</h4>
              {(!stats.mostPlayedTracks || stats.mostPlayedTracks.length === 0) ? (
                <div className="empty-panel-msg">No playback data recorded for this time range.</div>
              ) : (
                <ol className="analytics-ranked-list">
                  {stats.mostPlayedTracks.map((t, idx) => (
                    <li key={t.trackId || idx} className="ranked-row">
                      <span className="rank-num">#{idx + 1}</span>
                      <div className="rank-info">
                        <span className="rank-name" title={t.title}>{t.title}</span>
                        <span className="rank-sub" title={t.artist || 'Unknown Artist'}>{t.artist || 'Unknown Artist'}</span>
                      </div>
                      <span className="rank-badge">{t.playCount} plays</span>
                      <button
                        className="item-btn play-btn"
                        onClick={() => handleQueueSong(t.title)}
                        title={`Queue ${t.title}`}
                        aria-label={`Queue ${t.title}`}
                        style={{
                          padding: '0.2rem 0.45rem',
                          fontSize: '0.72rem',
                          marginLeft: '0.25rem',
                        }}
                      >
                        ➕
                      </button>
                    </li>
                  ))}
                </ol>
              )}
            </div>

            {/* Top Artists */}
            <div className="analytics-panel-box glass-card">
              <h4 className="panel-box-title">🎙️ Top Artists</h4>
              {(!stats.topArtists || stats.topArtists.length === 0) ? (
                <div className="empty-panel-msg">No artist data recorded for this time range.</div>
              ) : (
                <ol className="analytics-ranked-list">
                  {stats.topArtists.map((a, idx) => (
                    <li key={idx} className="ranked-row">
                      <span className="rank-num">#{idx + 1}</span>
                      <div className="rank-info">
                        <span className="rank-name" title={a.artist}>{a.artist}</span>
                      </div>
                      <span className="rank-badge">{a.playCount} plays</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>

            {/* Most Active Listeners */}
            <div className="analytics-panel-box glass-card">
              <h4 className="panel-box-title">🎧 Most Active Listeners</h4>
              {(!stats.mostActiveListeners || stats.mostActiveListeners.length === 0) ? (
                <div className="empty-panel-msg">No listener data recorded.</div>
              ) : (
                <ol className="analytics-ranked-list">
                  {stats.mostActiveListeners.map((u, idx) => (
                    <li key={idx} className="ranked-row">
                      <span className="rank-num">#{idx + 1}</span>
                      <div className="rank-info">
                        <span className="rank-name">User {u.userId ? u.userId.slice(0, 8) + '...' : 'Anonymous'}</span>
                        <span className="rank-sub">{formatListeningTime(u.totalListeningSeconds ?? 0)}</span>
                      </div>
                      <span className="rank-badge">{u.playCount} songs</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
