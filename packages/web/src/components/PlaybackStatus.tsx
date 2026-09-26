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

export interface SettingsStatePayload {
  volume: number;
  filters: {
    bassboost: boolean;
    speed: number;
    nightcore: boolean;
  };
  loopMode: 'off' | 'track' | 'queue';
  stayInChannel: boolean;
}

export interface LifecycleStatePayload {
  humanCount: number;
  timerActive: boolean;
  reason?: 'empty_channel' | 'queue_empty' | null;
  stayInChannel: boolean;
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

const DEFAULT_SETTINGS: SettingsStatePayload = {
  volume: 100,
  filters: {
    bassboost: false,
    speed: 1.0,
    nightcore: false,
  },
  loopMode: 'off',
  stayInChannel: false,
};

const DEFAULT_LIFECYCLE: LifecycleStatePayload = {
  humanCount: 0,
  timerActive: false,
  reason: null,
  stayInChannel: false,
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
  const [settings, setSettings] = useState<SettingsStatePayload>(DEFAULT_SETTINGS);
  const [lifecycle, setLifecycle] = useState<LifecycleStatePayload>(DEFAULT_LIFECYCLE);
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
              fetchGuildData(data.primary.guildId);
            }
          } else if (data.voiceState) {
            setPlayback(data);
            if (data.guildId) {
              fetchGuildData(data.guildId);
            }
          }
        }
      } catch {
        // Backend not yet reachable
      }
    };

    const fetchGuildData = async (guildId: string) => {
      try {
        const queueRes = await fetch(`/api/queue/${guildId}`);
        if (queueRes.ok) {
          const qData: QueueStatePayload = await queueRes.json();
          setQueueState(qData);
        }

        const stateRes = await fetch(`/api/playback/${guildId}/state`);
        if (stateRes.ok) {
          const sData = await stateRes.json();
          if (sData.state) {
            setSettings({
              volume: sData.state.volume ?? 100,
              filters: sData.state.filters ?? DEFAULT_SETTINGS.filters,
              loopMode: sData.state.loopMode ?? 'off',
              stayInChannel: sData.state.stayInChannel ?? false,
            });
            setLifecycle({
              humanCount: sData.state.humanCount ?? 0,
              timerActive: sData.state.voiceIdleTimerActive ?? false,
              reason: sData.state.voiceIdleReason ?? null,
              stayInChannel: sData.state.stayInChannel ?? false,
            });
          }
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
              fetchGuildData(msg.payload.guildId);
            }
          } else if (msg.type === 'queue.updated') {
            setQueueState({
              guildId: msg.guildId,
              currentTrack: msg.currentTrack,
              queue: msg.queue || [],
              length: msg.length ?? (msg.queue ? msg.queue.length : 0),
            });
          } else if (msg.type === 'playback.settings.updated') {
            setSettings({
              volume: msg.volume ?? 100,
              filters: msg.filters ?? DEFAULT_SETTINGS.filters,
              loopMode: msg.loopMode ?? 'off',
              stayInChannel: msg.stayInChannel ?? false,
            });
          } else if (msg.type === 'voice.lifecycle.updated') {
            setLifecycle({
              humanCount: msg.humanCount ?? 0,
              timerActive: msg.timerActive ?? false,
              reason: msg.reason ?? null,
              stayInChannel: msg.stayInChannel ?? false,
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

      {/* Audio Controls & DSP Effects Bar */}
      <div className="effects-bar">
        <div className="effect-chip volume-chip" title="Active Volume">
          <span className="chip-icon">🔊</span>
          <span className="chip-text">{settings.volume}%</span>
        </div>

        <div
          className={`effect-chip ${settings.filters.bassboost ? 'active' : ''}`}
          title="Bassboost filter"
        >
          <span className="chip-icon">🎚️</span>
          <span className="chip-text">
            Bass: {settings.filters.bassboost ? 'ON' : 'OFF'}
          </span>
        </div>

        <div
          className={`effect-chip ${settings.filters.speed !== 1.0 ? 'active' : ''}`}
          title="Playback speed"
        >
          <span className="chip-icon">⏩</span>
          <span className="chip-text">{settings.filters.speed}x</span>
        </div>

        <div
          className={`effect-chip ${settings.filters.nightcore ? 'active' : ''}`}
          title="Nightcore effect"
        >
          <span className="chip-icon">✨</span>
          <span className="chip-text">
            Nightcore: {settings.filters.nightcore ? 'ON' : 'OFF'}
          </span>
        </div>

        <div
          className={`effect-chip ${settings.loopMode !== 'off' ? 'active' : ''}`}
          title="Loop mode"
        >
          <span className="chip-icon">🔁</span>
          <span className="chip-text">Loop: {settings.loopMode.toUpperCase()}</span>
        </div>

        {lifecycle.timerActive && (
          <div className="effect-chip timer-chip" title="Inactivity auto-leave timer">
            <span className="chip-icon">⏱️</span>
            <span className="chip-text">
              Auto-Leave ({lifecycle.reason === 'empty_channel' ? 'empty' : 'idle'})
            </span>
          </div>
        )}
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
