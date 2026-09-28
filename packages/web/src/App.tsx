import { useState, useEffect, useRef } from 'react';
import { NowPlayingCard } from './components/NowPlayingCard';
import { QueueSection } from './components/QueueSection';
import { LyricsPanel } from './components/LyricsPanel';
import { LibrarySection } from './components/LibrarySection';
import { PlaylistSection } from './components/PlaylistSection';
import { AnalyticsDashboard } from './components/AnalyticsDashboard';
import { DJModePanel } from './components/DJModePanel';
import { HealthCheck } from './components/HealthCheck';
import { PlaybackStatus } from './components/PlaybackStatus';
import { StemMixingSection } from './components/StemMixingSection';
import { DJTransitionSection } from './components/DJTransitionSection';
import { SmartDJSection } from './components/SmartDJSection';
import { RecordingsSection } from './components/RecordingsSection';
import type {
  PlaybackStatePayload,
  QueueStatePayload,
  SettingsStatePayload,
} from './components/PlaybackStatus';

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

function App() {
  const [activeMainTab, setActiveMainTab] = useState<'player' | 'library' | 'recordings' | 'analytics' | 'engine'>('player');
  const [playback, setPlayback] = useState<PlaybackStatePayload>(DEFAULT_PLAYBACK);
  const [queueState, setQueueState] = useState<QueueStatePayload>(DEFAULT_QUEUE);
  const [settings, setSettings] = useState<SettingsStatePayload>(DEFAULT_SETTINGS);
  const [wsConnected, setWsConnected] = useState<boolean>(false);
  const [isReconnecting, setIsReconnecting] = useState<boolean>(false);

  const wsRef = useRef<WebSocket | null>(null);
  const guildId = playback.guildId || queueState.guildId || 'web-dashboard';

  // Authoritative State Fetcher (Requirement 26)
  const refreshAuthoritativeState = async (targetGuildId?: string) => {
    try {
      const pRes = await fetch('/api/playback');
      if (pRes.ok) {
        const pData = await pRes.json();
        const active = pData.primary || pData;
        if (active) {
          setPlayback(active);
          const gid = targetGuildId || active.guildId || 'web-dashboard';
          if (gid) {
            const [qRes, sRes] = await Promise.all([
              fetch(`/api/queue/${gid}`).catch(() => null),
              fetch(`/api/playback/${gid}/state`).catch(() => null),
            ]);

            if (qRes && qRes.ok) {
              const qData = await qRes.json();
              setQueueState(qData);
            }

            if (sRes && sRes.ok) {
              const sData = await sRes.json();
              if (sData.state) {
                setSettings({
                  volume: sData.state.volume ?? 100,
                  filters: sData.state.filters ?? DEFAULT_SETTINGS.filters,
                  loopMode: sData.state.loopMode ?? 'off',
                  stayInChannel: sData.state.stayInChannel ?? false,
                });
              }
            }
          }
        }
      }
    } catch {
      // offline fallback
    }
  };

  // Initial load & WebSocket with Reconnection Logic (Requirement 26)
  useEffect(() => {
    refreshAuthoritativeState();

    let reconnectTimer: NodeJS.Timeout;
    let didConnectOnce = false;

    const connectWebSocket = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setWsConnected(true);
        setIsReconnecting(false);

        // On Reconnect: request authoritative state to avoid stale state (Requirement 26)
        if (didConnectOnce) {
          ws.send(JSON.stringify({ type: 'request_state', guildId }));
          refreshAuthoritativeState(guildId);
        }
        didConnectOnce = true;
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'playback_state' && msg.payload) {
            setPlayback(msg.payload);
            if (msg.payload.guildId) {
              refreshAuthoritativeState(msg.payload.guildId);
            }
          } else if (msg.type === 'queue.updated') {
            setQueueState({
              guildId: msg.guildId,
              currentTrack: msg.currentTrack,
              queue: msg.queue || [],
              length: msg.length ?? (msg.queue ? msg.queue.length : 0),
            });
          } else if (msg.type === 'playback.settings.updated') {
            setSettings((prev) => ({
              ...prev,
              volume: msg.volume ?? prev.volume,
              filters: msg.filters ?? prev.filters,
              loopMode: msg.loopMode ?? prev.loopMode,
              stayInChannel: msg.stayInChannel ?? prev.stayInChannel,
            }));
          }
        } catch {
          // ignore
        }
      };

      ws.onclose = () => {
        setWsConnected(false);
        setIsReconnecting(true);
        reconnectTimer = setTimeout(connectWebSocket, 3000);
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connectWebSocket();

    return () => {
      clearTimeout(reconnectTimer);
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  const activeTrack = queueState.currentTrack || playback.track;

  return (
    <div className="app-container">
      {/* Top Navigation Bar */}
      <header className="app-header glass-panel">
        <div className="brand-group">
          <span className="brand-logo">🎵</span>
          <div className="brand-text">
            <h1 className="brand-title">Gakki</h1>
            <span className="brand-version">Music Platform • v0.10.0</span>
          </div>
        </div>

        {/* Global Navigation Tabs */}
        <nav className="nav-tabs" role="tablist" aria-label="Main Navigation">
          <button
            className={`nav-tab-btn ${activeMainTab === 'player' ? 'active' : ''}`}
            onClick={() => setActiveMainTab('player')}
            role="tab"
            aria-selected={activeMainTab === 'player'}
          >
            📻 Player & Queue
          </button>
          <button
            className={`nav-tab-btn ${activeMainTab === 'library' ? 'active' : ''}`}
            onClick={() => setActiveMainTab('library')}
            role="tab"
            aria-selected={activeMainTab === 'library'}
          >
            📚 Library & Playlists
          </button>
          <button
            className={`nav-tab-btn ${activeMainTab === 'recordings' ? 'active' : ''}`}
            onClick={() => setActiveMainTab('recordings')}
            role="tab"
            aria-selected={activeMainTab === 'recordings'}
          >
            🎙️ Recordings
          </button>
          <button
            className={`nav-tab-btn ${activeMainTab === 'analytics' ? 'active' : ''}`}
            onClick={() => setActiveMainTab('analytics')}
            role="tab"
            aria-selected={activeMainTab === 'analytics'}
          >
            📊 Statistics
          </button>
          <button
            className={`nav-tab-btn ${activeMainTab === 'engine' ? 'active' : ''}`}
            onClick={() => setActiveMainTab('engine')}
            role="tab"
            aria-selected={activeMainTab === 'engine'}
          >
            🎛️ Audio Engine & DJ
          </button>
        </nav>

        {/* WebSocket Reliability Status Indicator (Requirement 26) */}
        <div className="header-status-group">
          <span
            className={`ws-pill ${wsConnected ? 'connected' : isReconnecting ? 'reconnecting' : 'disconnected'}`}
            title={wsConnected ? 'WebSocket Live & Synced' : 'Reconnecting to backend...'}
          >
            <span className="ws-dot" />
            {wsConnected ? 'LIVE' : isReconnecting ? 'RECONNECTING...' : 'OFFLINE'}
          </span>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="app-main-layout">
        {/* 1. Player & Queue Tab */}
        {activeMainTab === 'player' && (
          <div className="player-tab-layout">
            <div className="player-top-row">
              <NowPlayingCard
                playback={playback}
                queueState={queueState}
                settings={settings}
                guildId={guildId}
                onRefreshQueue={() => refreshAuthoritativeState(guildId)}
                onRefreshSettings={() => refreshAuthoritativeState(guildId)}
              />
              <LyricsPanel
                trackTitle={activeTrack?.name}
                trackArtist={activeTrack?.artist}
                trackDuration={activeTrack?.duration}
                trackId={activeTrack?.id}
                isPlaying={playback.playerState === 'PLAYING'}
              />
            </div>

            <div className="player-bottom-row">
              <QueueSection
                queueState={queueState}
                guildId={guildId}
                onRefresh={() => refreshAuthoritativeState(guildId)}
              />
              <DJModePanel guildId={guildId} />
            </div>
          </div>
        )}

        {/* 2. Library & Playlists Tab */}
        {activeMainTab === 'library' && (
          <div className="library-tab-layout">
            <LibrarySection
              guildId={guildId}
              onEnqueueTrack={(input) => {
                fetch(`/api/queue/${guildId}/tracks`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ files: [input], addedBy: 'Web UI' }),
                }).then(() => refreshAuthoritativeState(guildId));
              }}
            />
            <PlaylistSection />
          </div>
        )}

        {/* 3. Voice Recordings & Transcripts Tab */}
        {activeMainTab === 'recordings' && (
          <div className="recordings-tab-layout">
            <RecordingsSection guildId={guildId} />
          </div>
        )}

        {/* 4. Statistics Tab */}
        {activeMainTab === 'analytics' && (
          <div className="analytics-tab-layout">
            <AnalyticsDashboard guildId={guildId} />
          </div>
        )}

        {/* 4. Advanced DJ & Audio Engine Tab */}
        {activeMainTab === 'engine' && (
          <div className="engine-tab-layout">
            <StemMixingSection />
            <DJTransitionSection />
            <SmartDJSection />
            <PlaybackStatus />
            <HealthCheck />
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="app-footer">
        <p>Gakki Music Platform — Phase 10 Lyrics, Music Library UX & Product Polish</p>
      </footer>
    </div>
  );
}

export default App;
