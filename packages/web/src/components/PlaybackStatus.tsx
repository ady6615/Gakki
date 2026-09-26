import { useEffect, useState, useRef } from 'react';

export interface PlaybackTrack {
  name: string;
  duration: number | null;
  artist?: string | null;
}

export interface PlaybackStatePayload {
  guildId: string | null;
  voiceState: 'CONNECTED' | 'CONNECTING' | 'DISCONNECTED' | 'ERROR';
  playerState: 'IDLE' | 'PLAYING' | 'PAUSED' | 'ERROR';
  track: PlaybackTrack | null;
}

const DEFAULT_STATE: PlaybackStatePayload = {
  guildId: null,
  voiceState: 'DISCONNECTED',
  playerState: 'IDLE',
  track: null,
};

function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || isNaN(seconds)) return '--:--';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function PlaybackStatus() {
  const [playback, setPlayback] = useState<PlaybackStatePayload>(DEFAULT_STATE);
  const [wsConnected, setWsConnected] = useState<boolean>(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    // Initial fetch from REST API
    const fetchInitialState = async () => {
      try {
        const res = await fetch('/api/playback');
        if (res.ok) {
          const data = await res.json();
          if (data.primary) {
            setPlayback(data.primary);
          } else if (data.voiceState) {
            setPlayback(data);
          }
        }
      } catch {
        // Backend not yet reachable
      }
    };

    fetchInitialState();

    // WebSocket connection
    let reconnectTimer: NodeJS.Timeout;
    const connectWs = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setWsConnected(true);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'playback_state' && msg.payload) {
            setPlayback(msg.payload);
          }
        } catch {
          // ignore malformed message
        }
      };

      ws.onclose = () => {
        setWsConnected(false);
        reconnectTimer = setTimeout(connectWs, 3000);
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connectWs();

    return () => {
      clearTimeout(reconnectTimer);
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  const voiceClass = playback.voiceState.toLowerCase();
  const playerClass = playback.playerState.toLowerCase();

  return (
    <div className="playback-card">
      <div className="playback-header">
        <h2 className="playback-title">
          <span>📻</span> Voice & Playback Status
        </h2>
        <span
          className={`ws-indicator ${wsConnected ? 'connected' : 'disconnected'}`}
          title={wsConnected ? 'WebSocket live' : 'WebSocket disconnected'}
        >
          <span className="ws-dot" />
          {wsConnected ? 'LIVE' : 'OFFLINE'}
        </span>
      </div>

      <div className="playback-indicators">
        <div className="status-box">
          <span className="status-label">Voice Channel</span>
          <span className={`status-badge voice-${voiceClass}`}>
            <span className={`status-dot voice-${voiceClass}`} />
            {playback.voiceState}
          </span>
        </div>

        <div className="status-box">
          <span className="status-label">Player Engine</span>
          <span className={`status-badge player-${playerClass}`}>
            <span className={`status-dot player-${playerClass}`} />
            {playback.playerState}
          </span>
        </div>
      </div>

      <div className="track-section">
        <div className="track-label">Current Track</div>
        {playback.track ? (
          <div className="track-info">
            <div className="track-icon-wrapper">
              <span className={`disc-icon ${playback.playerState === 'PLAYING' ? 'spinning' : ''}`}>
                💿
              </span>
            </div>
            <div className="track-details">
              <div className="track-name">{playback.track.name}</div>
              {playback.track.artist && (
                <div className="track-artist">{playback.track.artist}</div>
              )}
              <div className="track-meta">
                <span className="track-duration">
                  Duration: {formatDuration(playback.track.duration)}
                </span>
                {playback.guildId && (
                  <span className="track-guild">Guild: {playback.guildId}</span>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="no-track">
            <span>No track currently playing</span>
            <small>Use <code>/play</code> in Discord to start local playback</small>
          </div>
        )}
      </div>

      {playback.playerState === 'PLAYING' && (
        <div className="audio-bars">
          <span className="bar bar-1" />
          <span className="bar bar-2" />
          <span className="bar bar-3" />
          <span className="bar bar-4" />
          <span className="bar bar-5" />
        </div>
      )}
    </div>
  );
}
