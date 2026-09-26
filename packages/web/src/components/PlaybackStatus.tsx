import { useEffect, useState, useRef } from 'react';

export interface PlaybackTrack {
  id?: string;
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

export interface QueueDisplayItem {
  position: number;
  id: string;
  name: string;
  duration?: number;
  addedBy?: string;
}

export interface QueueStatePayload {
  guildId: string;
  currentTrack: PlaybackTrack | null;
  queue: QueueDisplayItem[];
  length: number;
}

const DEFAULT_PLAYBACK: PlaybackStatePayload = {
  guildId: null,
  voiceState: 'DISCONNECTED',
  playerState: 'IDLE',
  track: null,
};

const DEFAULT_QUEUE: QueueStatePayload = {
  guildId: '',
  currentTrack: null,
  queue: [],
  length: 0,
};

function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || isNaN(seconds)) return '--:--';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function PlaybackStatus() {
  const [playback, setPlayback] = useState<PlaybackStatePayload>(DEFAULT_PLAYBACK);
  const [queueState, setQueueState] = useState<QueueStatePayload>(DEFAULT_QUEUE);
  const [wsConnected, setWsConnected] = useState<boolean>(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    // Initial fetch from REST API
    const fetchInitialData = async () => {
      try {
        const res = await fetch('/api/playback');
        if (res.ok) {
          const data = await res.json();
          if (data.primary) {
            setPlayback(data.primary);
            if (data.primary.guildId) {
              fetchQueue(data.primary.guildId);
            }
          } else if (data.voiceState) {
            setPlayback(data);
            if (data.guildId) {
              fetchQueue(data.guildId);
            }
          }
        }
      } catch {
        // Backend not yet reachable
      }
    };

    const fetchQueue = async (guildId: string) => {
      try {
        const res = await fetch(`/api/queue/${guildId}`);
        if (res.ok) {
          const data: QueueStatePayload = await res.json();
          setQueueState(data);
        }
      } catch {
        // Ignore
      }
    };

    fetchInitialData();

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
            if (msg.payload.guildId) {
              fetchQueue(msg.payload.guildId);
            }
          } else if (msg.type === 'queue.updated') {
            setQueueState({
              guildId: msg.guildId,
              currentTrack: msg.currentTrack,
              queue: msg.queue || [],
              length: msg.length ?? (msg.queue ? msg.queue.length : 0),
            });
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
  const activeTrack = queueState.currentTrack || playback.track;

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
        {activeTrack ? (
          <div className="track-info">
            <div className="track-icon-wrapper">
              <span className={`disc-icon ${playback.playerState === 'PLAYING' ? 'spinning' : ''}`}>
                💿
              </span>
            </div>
            <div className="track-details">
              <div className="track-name">{activeTrack.name}</div>
              {activeTrack.artist && (
                <div className="track-artist">{activeTrack.artist}</div>
              )}
              <div className="track-meta">
                <span className="track-duration">
                  Duration: {formatDuration(activeTrack.duration)}
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
            <small>Use <code>/play</code> in Discord to start playback</small>
          </div>
        )}
      </div>

      {/* Queue Section */}
      <div className="queue-section">
        <div className="queue-header">
          <span className="queue-label">Upcoming Queue</span>
          <span className="queue-count-badge">
            {queueState.length} {queueState.length === 1 ? 'track' : 'tracks'}
          </span>
        </div>

        {queueState.queue.length > 0 ? (
          <div className="queue-list">
            {queueState.queue.map((item) => (
              <div key={item.id} className="queue-item">
                <span className="queue-item-pos">{item.position}</span>
                <div className="queue-item-details">
                  <span className="queue-item-name">{item.name}</span>
                  {item.addedBy && (
                    <span className="queue-item-by">Added by {item.addedBy}</span>
                  )}
                </div>
                <span className="queue-item-duration">
                  {formatDuration(item.duration)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="queue-empty">
            <span>The queue is empty.</span>
            <small>Use <code>/play</code> or <code>/addqueue</code> to queue more tracks</small>
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
