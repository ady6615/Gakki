import { useState, useEffect } from 'react';

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
}

function formatListeningTime(totalSeconds: number): string {
  if (!totalSeconds || isNaN(totalSeconds)) return '0 min';
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

export function AnalyticsDashboard({ guildId }: AnalyticsDashboardProps) {
  const [timeRange, setTimeRange] = useState<'today' | '7d' | '30d' | 'all'>('7d');
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [viewScope, setViewScope] = useState<'guild' | 'user'>('guild');

  useEffect(() => {
    let isMounted = true;
    setLoading(true);

    const queryParams = new URLSearchParams();
    queryParams.set('timeRange', timeRange);
    if (viewScope === 'guild' && guildId) {
      queryParams.set('guildId', guildId);
    }

    fetch(`/api/analytics/dashboard?${queryParams.toString()}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (isMounted) {
          setStats(data);
          setLoading(false);
        }
      })
      .catch(() => {
        if (isMounted) setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [timeRange, viewScope, guildId]);

  return (
    <section className="analytics-dashboard glass-panel" aria-label="Playback Analytics Dashboard">
      <div className="analytics-header">
        <div className="analytics-header-left">
          <h3 className="analytics-title">
            <span className="analytics-icon">📊</span> Statistics & Listening Analytics
          </h3>
          <button
            className="analytics-scope-pill"
            onClick={() => setViewScope((prev) => (prev === 'guild' ? 'user' : 'guild'))}
            title="Click to toggle Server vs Personal listening"
          >
            {viewScope === 'guild' ? '🌐 Server Listening' : '👤 Personal Listening'}
          </button>
        </div>

        {/* Time-Range Selector Buttons (Requirement 16) */}
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

      {loading && (
        <div className="analytics-loading">
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
                <span className="kpi-value">{stats.totalPlays.toLocaleString()}</span>
                <span className="kpi-label">TOTAL PLAYS</span>
              </div>
            </div>

            <div className="kpi-card glass-card">
              <span className="kpi-icon">⏳</span>
              <div className="kpi-data">
                <span className="kpi-value">{formatListeningTime(stats.totalListeningSeconds)}</span>
                <span className="kpi-label">LISTENING TIME</span>
              </div>
            </div>

            <div className="kpi-card glass-card">
              <span className="kpi-icon">🎯</span>
              <div className="kpi-data">
                <span className="kpi-value">{Math.round(stats.completionRate * 100)}%</span>
                <span className="kpi-label">COMPLETION RATE</span>
              </div>
            </div>

            <div className="kpi-card glass-card">
              <span className="kpi-icon">⏭️</span>
              <div className="kpi-data">
                <span className="kpi-value">{Math.round(stats.skipRate * 100)}%</span>
                <span className="kpi-label">SKIP RATE</span>
              </div>
            </div>
          </div>

          {/* Detailed Lists */}
          <div className="analytics-columns-grid">
            {/* Most Played Tracks */}
            <div className="analytics-panel-box glass-card">
              <h4 className="panel-box-title">🔥 Most Played Tracks</h4>
              {stats.mostPlayedTracks.length === 0 ? (
                <div className="empty-panel-msg">No playback data for this period.</div>
              ) : (
                <ol className="analytics-ranked-list">
                  {stats.mostPlayedTracks.map((t, idx) => (
                    <li key={t.trackId || idx} className="ranked-row">
                      <span className="rank-num">#{idx + 1}</span>
                      <div className="rank-info">
                        <span className="rank-name">{t.title}</span>
                        <span className="rank-sub">{t.artist || 'Unknown'}</span>
                      </div>
                      <span className="rank-badge">{t.playCount} plays</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>

            {/* Top Artists */}
            <div className="analytics-panel-box glass-card">
              <h4 className="panel-box-title">🎙️ Top Artists</h4>
              {stats.topArtists.length === 0 ? (
                <div className="empty-panel-msg">No artist data for this period.</div>
              ) : (
                <ol className="analytics-ranked-list">
                  {stats.topArtists.map((a, idx) => (
                    <li key={idx} className="ranked-row">
                      <span className="rank-num">#{idx + 1}</span>
                      <div className="rank-info">
                        <span className="rank-name">{a.artist}</span>
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
              {stats.mostActiveListeners.length === 0 ? (
                <div className="empty-panel-msg">No listener data recorded.</div>
              ) : (
                <ol className="analytics-ranked-list">
                  {stats.mostActiveListeners.map((u, idx) => (
                    <li key={idx} className="ranked-row">
                      <span className="rank-num">#{idx + 1}</span>
                      <div className="rank-info">
                        <span className="rank-name">User {u.userId.slice(0, 8)}...</span>
                        <span className="rank-sub">{formatListeningTime(u.totalListeningSeconds)}</span>
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
