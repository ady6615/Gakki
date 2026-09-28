import { useEffect, useState, useRef } from 'react';

export interface AcousticFeatures {
  bpm: number | null;
  tempoConfidence: number | null;
  energy: number | null;
  key: string | null;
  analysisStatus: 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED';
}

export interface RecommendationCandidate {
  trackId: string;
  title: string;
  artist: string | null;
  similarityScore: number;
  preferenceScore: number;
  tempoScore: number;
  energyScore: number;
  noveltyScore: number;
  finalScore: number;
  reasons: string[];
  explanation: string;
}

export interface DJState {
  guildId: string;
  enabled: boolean;
  profile: 'CHILL' | 'BALANCED' | 'ENERGETIC';
  lookaheadQueue: RecommendationCandidate[];
  recentTrackIds: string[];
  lastEnergy: number | null;
  lastBpm: number | null;
}

export function SmartDJSection() {
  const [guildId, setGuildId] = useState<string>('default-guild');
  const [djState, setDjState] = useState<DJState>({
    guildId: 'default-guild',
    enabled: false,
    profile: 'BALANCED',
    lookaheadQueue: [],
    recentTrackIds: [],
    lastEnergy: null,
    lastBpm: null,
  });

  const [currentTrack, setCurrentTrack] = useState<{ id?: string; trackId?: string; name?: string; artist?: string } | null>(null);
  const [currentFeatures, setCurrentFeatures] = useState<AcousticFeatures | null>(null);
  const [suggestions, setSuggestions] = useState<RecommendationCandidate[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // 1. Initial State & Active Playback Detection
  useEffect(() => {
    const fetchPlaybackAndDJ = async () => {
      try {
        const res = await fetch('/api/playback');
        if (res.ok) {
          const data = await res.json();
          const activeGuild = data.primary?.guildId || data.guildId || 'default-guild';
          setGuildId(activeGuild);
          if (data.primary?.track || data.track) {
            const track = data.primary?.track || data.track;
            setCurrentTrack(track);
            if (track.trackId || track.id) {
              fetchTrackFeatures(track.trackId || track.id);
            }
          }
          fetchDJState(activeGuild);
        }
      } catch {
        // Fallback to default guild if offline
        fetchDJState('default-guild');
      }
    };

    fetchPlaybackAndDJ();
  }, []);

  // 2. WebSocket listener for live DJ and analysis events
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    const connectWs = () => {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'dj.enabled') {
            setDjState((prev) => ({ ...prev, enabled: true, profile: data.profile || prev.profile }));
            showToast('Dynamic DJ enabled');
          } else if (data.type === 'dj.disabled') {
            setDjState((prev) => ({ ...prev, enabled: false }));
            showToast('Dynamic DJ disabled');
          } else if (data.type === 'dj.next.selected') {
            showToast(`DJ selected next: ${data.title}`);
            fetchDJState(data.guildId || guildId);
          } else if (data.type === 'recommendation.generated') {
            fetchDJState(data.guildId || guildId);
          } else if (data.type === 'analysis.completed') {
            if (currentTrack && (currentTrack.trackId === data.trackId || currentTrack.id === data.trackId)) {
              fetchTrackFeatures(data.trackId);
            }
          } else if (data.type === 'playback_state') {
            if (data.payload?.track) {
              setCurrentTrack(data.payload.track);
              if (data.payload.track.trackId || data.payload.track.id) {
                fetchTrackFeatures(data.payload.track.trackId || data.payload.track.id);
              }
            }
          }
        } catch {
          // ignore parsing error
        }
      };

      ws.onclose = () => {
        setTimeout(connectWs, 3000);
      };
    };

    connectWs();
    return () => {
      if (wsRef.current) wsRef.current.close();
    };
  }, [guildId, currentTrack]);

  const showToast = (msg: string) => {
    setActionMessage(msg);
    setTimeout(() => setActionMessage(null), 4000);
  };

  const fetchDJState = async (gid: string) => {
    try {
      const res = await fetch(`/api/recommendations/dj/${gid}`);
      if (res.ok) {
        const data = await res.json();
        setDjState(data);
        if (data.lookaheadQueue && data.lookaheadQueue.length > 0) {
          setSuggestions(data.lookaheadQueue);
        } else {
          fetchSimilarSuggestions(gid, data.profile);
        }
      }
    } catch {
      // offline fallback
    }
  };

  const fetchTrackFeatures = async (trackId: string) => {
    try {
      const res = await fetch(`/api/recommendations/features/${trackId}`);
      if (res.ok) {
        const features = await res.json();
        setCurrentFeatures(features);
      }
    } catch {
      // feature not yet ready
    }
  };

  const fetchSimilarSuggestions = async (_gid: string, profile: 'CHILL' | 'BALANCED' | 'ENERGETIC') => {
    if (!currentTrack) return;
    const trackId = currentTrack.trackId || currentTrack.id;
    if (!trackId) return;

    try {
      const res = await fetch(`/api/recommendations/similar/${trackId}?limit=3&profile=${profile}`);
      if (res.ok) {
        const data = await res.json();
        setSuggestions(data.tracks || []);
      }
    } catch {
      // ignore
    }
  };

  const handleToggleDJ = async () => {
    setLoading(true);
    try {
      const newEnabled = !djState.enabled;
      const res = await fetch('/api/recommendations/dj/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guildId, enabled: newEnabled, profile: djState.profile }),
      });
      if (res.ok) {
        const updated = await res.json();
        setDjState(updated);
        showToast(newEnabled ? '🎛️ Dynamic DJ activated!' : '🎛️ Dynamic DJ deactivated');
      }
    } catch {
      showToast('Failed to toggle DJ mode');
    } finally {
      setLoading(false);
    }
  };

  const handleProfileChange = async (profile: 'CHILL' | 'BALANCED' | 'ENERGETIC') => {
    try {
      const res = await fetch('/api/recommendations/dj/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guildId, profile }),
      });
      if (res.ok) {
        const updated = await res.json();
        setDjState(updated);
        showToast(`DJ Profile set to ${profile}`);
        fetchSimilarSuggestions(guildId, profile);
      }
    } catch {
      showToast('Failed to update DJ profile');
    }
  };

  const handleSmartShuffle = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/recommendations/smart-shuffle/${guildId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: djState.profile }),
      });
      if (res.ok) {
        const data = await res.json();
        showToast(`🔀 Smart-shuffled ${data.count || 0} tracks by rhythm & acoustic flow!`);
      } else {
        showToast('Smart Shuffle requires at least 2 tracks in queue');
      }
    } catch {
      showToast('Smart Shuffle failed');
    } finally {
      setLoading(false);
    }
  };

  const handleVibeMatch = async () => {
    if (!currentTrack) {
      showToast('Play a track first to generate a vibe match');
      return;
    }
    const seedTrackId = currentTrack.trackId || currentTrack.id;
    if (!seedTrackId) return;

    setLoading(true);
    try {
      const res = await fetch('/api/recommendations/vibe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seedTrackId, guildId, limit: 5, profile: djState.profile }),
      });
      if (res.ok) {
        const data = await res.json();
        setSuggestions(data.tracks || []);
        showToast(`🎧 Generated Vibe Playlist (${data.tracks?.length || 0} tracks)`);
      } else {
        showToast('No similar acoustic profiles found yet');
      }
    } catch {
      showToast('Vibe Match failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="smart-dj-card" aria-label="Smart DJ & Recommendations">
      {/* Toast Banner */}
      {actionMessage && (
        <div className="dj-toast-banner" role="status">
          <span>{actionMessage}</span>
        </div>
      )}

      {/* Header & Controls */}
      <div className="dj-header">
        <div className="dj-title-group">
          <div className="dj-badge">
            <span className="dj-pulse-dot" />
            <span>AI ACOUSTIC ENGINE</span>
          </div>
          <h2 className="dj-title">SMART DJ</h2>
        </div>

        <div className="dj-profile-selector" role="radiogroup" aria-label="DJ Profile">
          {(['CHILL', 'BALANCED', 'ENERGETIC'] as const).map((p) => (
            <button
              key={p}
              type="button"
              className={`dj-profile-pill ${djState.profile === p ? 'active' : ''}`}
              onClick={() => handleProfileChange(p)}
            >
              {p === 'CHILL' ? '🌙 Chill' : p === 'ENERGETIC' ? '⚡ Energetic' : '⚖️ Balanced'}
            </button>
          ))}
        </div>
      </div>

      {/* Current Track Acoustic Characteristics */}
      <div className="dj-current-panel">
        <span className="dj-section-label">CURRENT TRACK</span>
        <div className="dj-current-track-info">
          <div className="dj-track-title">{currentTrack?.name || 'No track playing'}</div>
          {currentTrack?.artist && <div className="dj-track-artist">{currentTrack.artist}</div>}
        </div>

        {currentFeatures && currentFeatures.analysisStatus === 'READY' && (
          <div className="dj-features-grid">
            <div className="dj-feature-metric">
              <span className="metric-label">BPM</span>
              <span className="metric-value">{Math.round(currentFeatures.bpm || 0)}</span>
              <span className="metric-sub">{Math.round((currentFeatures.tempoConfidence || 0) * 100)}% conf</span>
            </div>

            <div className="dj-feature-metric">
              <span className="metric-label">ENERGY</span>
              <div className="metric-energy-bar">
                <div
                  className="metric-energy-fill"
                  style={{ width: `${Math.round((currentFeatures.energy || 0) * 100)}%` }}
                />
              </div>
              <span className="metric-sub">{Math.round((currentFeatures.energy || 0) * 100)}%</span>
            </div>

            <div className="dj-feature-metric">
              <span className="metric-label">KEY</span>
              <span className="metric-value">{currentFeatures.key || 'N/A'}</span>
              <span className="metric-sub">harmonic</span>
            </div>
          </div>
        )}
      </div>

      {/* Interactive Controls Bar */}
      <div className="dj-action-buttons">
        <button
          type="button"
          className="dj-action-btn btn-smart-shuffle"
          onClick={handleSmartShuffle}
          disabled={loading}
        >
          🔀 SMART SHUFFLE
        </button>

        <button
          type="button"
          className="dj-action-btn btn-vibe-match"
          onClick={handleVibeMatch}
          disabled={loading}
        >
          🎧 VIBE MATCH
        </button>

        <button
          type="button"
          className={`dj-action-btn btn-dj-mode ${djState.enabled ? 'active-dj' : ''}`}
          onClick={handleToggleDJ}
          disabled={loading}
        >
          {djState.enabled ? '🎛️ DJ MODE: ON' : '🎛️ DJ MODE: OFF'}
        </button>
      </div>

      {/* Next Suggestions List */}
      <div className="dj-suggestions-section">
        <span className="dj-section-label">NEXT SUGGESTIONS</span>
        {suggestions.length === 0 ? (
          <div className="dj-empty-suggestions">
            <p>No suggestions queued. Turn on DJ Mode or click <strong>VIBE MATCH</strong> to generate candidates.</p>
          </div>
        ) : (
          <div className="dj-suggestions-list">
            {suggestions.map((item, idx) => (
              <div key={item.trackId || idx} className="dj-suggestion-card">
                <div className="suggestion-play-icon">▶</div>
                <div className="suggestion-details">
                  <div className="suggestion-title">{item.title}</div>
                  {item.artist && <div className="suggestion-artist">{item.artist}</div>}
                  <div className="suggestion-reasons">
                    {item.reasons && item.reasons.length > 0 ? (
                      item.reasons.map((r, rIdx) => (
                        <span key={rIdx} className="reason-tag">
                          {r}
                        </span>
                      ))
                    ) : (
                      <span className="reason-tag">{item.explanation || 'Compatible acoustic match'}</span>
                    )}
                  </div>
                </div>
                <div className="suggestion-score-badge">
                  <span>{Math.round((item.finalScore || item.similarityScore || 0.8) * 100)}%</span>
                  <span className="score-label">match</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
