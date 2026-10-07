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
import { AudioRoutingSection } from './components/AudioRoutingSection';
import { VoiceCommandSection } from './components/VoiceCommandSection';
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

interface DiscordGuild {
  id: string;
  name: string;
  icon: string | null;
  memberCount: number;
  botInVoice: boolean;
  voiceChannelName: string | null;
}

function App() {
  const [activeMainTab, setActiveMainTab] = useState<'player' | 'library' | 'recordings' | 'voice' | 'analytics' | 'engine' | 'settings'>('player');
  const [playback, setPlayback] = useState<PlaybackStatePayload>(DEFAULT_PLAYBACK);
  const [queueState, setQueueState] = useState<QueueStatePayload>(DEFAULT_QUEUE);
  const [settings, setSettings] = useState<SettingsStatePayload>(DEFAULT_SETTINGS);
  const [wsConnected, setWsConnected] = useState<boolean>(false);
  const [isReconnecting, setIsReconnecting] = useState<boolean>(false);
  const [discordGuilds, setDiscordGuilds] = useState<DiscordGuild[]>([]);
  const [selectedGuildId, setSelectedGuildId] = useState<string>('');
  const [inviteUrl, setInviteUrl] = useState<string>('');

  const wsRef = useRef<WebSocket | null>(null);
  const guildId = selectedGuildId || playback.guildId || queueState.guildId || 'web-dashboard';

  // Authoritative State Fetcher (Requirement 26)
  const refreshAuthoritativeState = async (targetGuildId?: string) => {
    try {
      // 1. Fetch connected Discord servers & invite URL
      try {
        const dRes = await fetch('/api/discord/guilds');
        if (dRes.ok) {
          const dData = await dRes.json();
          if (dData.guilds && Array.isArray(dData.guilds)) {
            setDiscordGuilds(dData.guilds);
            if (!selectedGuildId && !targetGuildId && dData.guilds.length > 0) {
              const activeWithVoice = dData.guilds.find((g: DiscordGuild) => g.botInVoice);
              setSelectedGuildId(activeWithVoice ? activeWithVoice.id : dData.guilds[0].id);
            }
          }
          if (dData.inviteUrl) {
            setInviteUrl(dData.inviteUrl);
          }
        }
      } catch {
        // offline or no discord
      }

      // 2. Fetch Playback State
      const currentGid = targetGuildId || selectedGuildId;
      const pUrl = currentGid ? `/api/playback?guildId=${encodeURIComponent(currentGid)}` : '/api/playback';
      const pRes = await fetch(pUrl);
      if (pRes.ok) {
        const pData = await pRes.json();
        const active = pData.primary || pData;
        if (active) {
          setPlayback(active);
          const gid = targetGuildId || selectedGuildId || active.guildId || 'web-dashboard';
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

  // Sync Desktop Tray & Native Notifications (Requirements 20 & 22)
  useEffect(() => {
    if (!activeTrack) return;
    const isPlaying = playback.playerState === 'PLAYING';

    if (window.gakkiDesktop?.tray?.updateNowPlaying) {
      window.gakkiDesktop.tray.updateNowPlaying(activeTrack.name, activeTrack.artist || '', isPlaying);
    }
    if (window.gakkiDesktop?.notifications?.notifyTrackChange && isPlaying) {
      window.gakkiDesktop.notifications.notifyTrackChange(activeTrack.name, activeTrack.artist || '');
    }
  }, [activeTrack?.name, playback.playerState]);

  // Global Media Hotkeys listener from Electron main process (Requirement 21)
  useEffect(() => {
    if (!window.gakkiDesktop?.onMediaControl) return;

    const cleanup = window.gakkiDesktop.onMediaControl(async (action: string) => {
      if (action === 'play-pause') {
        const isPlaying = playback.playerState === 'PLAYING';
        await fetch(`/api/playback/${guildId}/${isPlaying ? 'pause' : 'resume'}`, { method: 'POST' });
        refreshAuthoritativeState(guildId);
      } else if (action === 'next') {
        await fetch(`/api/playback/${guildId}/skip`, { method: 'POST' });
        refreshAuthoritativeState(guildId);
      } else if (action === 'volume-up') {
        const nextVol = Math.min(200, settings.volume + 5);
        await fetch(`/api/playback/${guildId}/volume`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ volume: nextVol }),
        });
        refreshAuthoritativeState(guildId);
      } else if (action === 'volume-down') {
        const nextVol = Math.max(0, settings.volume - 5);
        await fetch(`/api/playback/${guildId}/volume`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ volume: nextVol }),
        });
        refreshAuthoritativeState(guildId);
      } else if (action === 'mute') {
        const nextVol = settings.volume > 0 ? 0 : 100;
        await fetch(`/api/playback/${guildId}/volume`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ volume: nextVol }),
        });
        refreshAuthoritativeState(guildId);
      }
    });

    return cleanup;
  }, [playback.playerState, settings.volume, guildId]);

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
            className={`nav-tab-btn ${activeMainTab === 'voice' ? 'active' : ''}`}
            onClick={() => setActiveMainTab('voice')}
            role="tab"
            aria-selected={activeMainTab === 'voice'}
          >
            🎤 Voice & Meet
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
          <button
            className={`nav-tab-btn ${activeMainTab === 'settings' ? 'active' : ''}`}
            onClick={() => setActiveMainTab('settings')}
            role="tab"
            aria-selected={activeMainTab === 'settings'}
          >
            ⚙️ Audio & Settings
          </button>
        </nav>

        {/* Header Controls: Server Selector, Invite Button, WebSocket Status */}
        <div className="header-status-group">
          {discordGuilds.length > 0 && (
            <div className="server-selector-container">
              <span className="server-selector-icon" title="Discord Servers">🌐</span>
              <select
                id="server-select"
                className="server-select-dropdown"
                value={selectedGuildId || guildId}
                onChange={(e) => {
                  const newGuildId = e.target.value;
                  setSelectedGuildId(newGuildId);
                  refreshAuthoritativeState(newGuildId);
                }}
                title="Switch between Discord servers"
              >
                {discordGuilds.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name} {g.botInVoice ? `🔊 (${g.voiceChannelName || 'Voice'})` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          {inviteUrl && (
            <a
              href={inviteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="invite-bot-btn"
              title="Add Gakki bot to another Discord server"
            >
              ➕ Add to Server
            </a>
          )}

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

        {/* 4. Voice Commands, Gemini & Meet Tab (Phase 13) */}
        {activeMainTab === 'voice' && (
          <div className="voice-tab-layout">
            <VoiceCommandSection />
          </div>
        )}

        {/* 5. Statistics Tab */}
        {activeMainTab === 'analytics' && (
          <div className="analytics-tab-layout">
            <AnalyticsDashboard
              guildId={guildId}
              onEnqueueTrack={(trackTitle) => {
                fetch(`/api/queue/${guildId}/tracks`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ files: [trackTitle], addedBy: 'Statistics Dashboard' }),
                }).then(() => refreshAuthoritativeState(guildId));
              }}
            />
          </div>
        )}

        {/* 6. Advanced DJ & Audio Engine Tab */}
        {activeMainTab === 'engine' && (
          <div className="engine-tab-layout">
            <StemMixingSection />
            <DJTransitionSection />
            <SmartDJSection />
            <PlaybackStatus />
            <HealthCheck />
          </div>
        )}

        {/* 7. Audio Routing & Desktop Settings Tab */}
        {activeMainTab === 'settings' && (
          <div className="settings-tab-layout">
            <AudioRoutingSection onRefresh={() => refreshAuthoritativeState(guildId)} />
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="app-footer">
        <p>Gakki Music Platform — Phase 13 Voice Commands, Gemini Voice Agent & Google Meet Integration</p>
      </footer>
    </div>
  );
}

export default App;
