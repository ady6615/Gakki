import { useEffect, useState } from 'react';
import type { PlaybackStatePayload, QueueStatePayload, SettingsStatePayload } from './PlaybackStatus';

interface TransitionVisualState {
  state: 'idle' | 'preparing' | 'ready' | 'mixing' | 'fallback';
  strategy?: string;
  fromTrack?: string;
  toTrack?: string;
  bpmChange?: string;
  keyChange?: string;
  progress?: number;
}

interface NowPlayingCardProps {
  playback: PlaybackStatePayload;
  queueState: QueueStatePayload;
  settings: SettingsStatePayload;
  guildId: string;
  onRefreshQueue?: () => void;
  onRefreshSettings?: () => void;
}

function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || isNaN(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function NowPlayingCard({
  playback,
  queueState,
  settings,
  guildId,
  onRefreshQueue,
  onRefreshSettings,
}: NowPlayingCardProps) {
  const activeTrack = queueState.currentTrack || playback.track;
  const isPlaying = playback.playerState === 'PLAYING';
  const isPaused = playback.playerState === 'PAUSED';

  // Local progress ticker for smooth UI
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [isFavorite, setIsFavorite] = useState(false);
  const [volume, setVolume] = useState(settings.volume);
  const [transition, setTransition] = useState<TransitionVisualState>({ state: 'idle' });
  const [actionLoading, setActionLoading] = useState(false);

  // Sync volume from settings
  useEffect(() => {
    setVolume(settings.volume);
  }, [settings.volume]);

  // Check if current track is favorited
  useEffect(() => {
    if (!activeTrack?.id) {
      setIsFavorite(false);
      return;
    }
    let isMounted = true;
    fetch(`/api/favorites/check/${activeTrack.id}`)
      .then((res) => res.json())
      .then((data) => {
        if (isMounted) setIsFavorite(Boolean(data.isFavorite));
      })
      .catch(() => {});
    return () => {
      isMounted = false;
    };
  }, [activeTrack?.id]);

  // Progress ticker: resets when track changes, increments every second when PLAYING
  useEffect(() => {
    setElapsedSeconds(0);
  }, [activeTrack?.name]);

  useEffect(() => {
    if (!isPlaying) return;
    const interval = setInterval(() => {
      setElapsedSeconds((prev) => {
        if (activeTrack?.duration && prev >= activeTrack.duration) {
          return prev;
        }
        return prev + 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [isPlaying, activeTrack?.duration]);

  // Listen to WebSocket events for DJ transitions
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'dj.transition.planned' || msg.type === 'transition.planned') {
            setTransition({
              state: 'preparing',
              strategy: msg.strategy || msg.plan?.strategy || 'Smart Transition',
              fromTrack: msg.fromTrackName || activeTrack?.name,
              toTrack: msg.toTrackName || 'Next Track',
              bpmChange: msg.bpmChange || (msg.fromBpm && msg.toBpm ? `${Math.round(msg.fromBpm)} BPM → ${Math.round(msg.toBpm)} BPM` : undefined),
              keyChange: msg.keyChange || (msg.fromKey && msg.toKey ? `${msg.fromKey} → ${msg.toKey}` : undefined),
            });
          } else if (msg.type === 'dj.transition.started' || msg.type === 'transition.started') {
            setTransition((prev) => ({
              ...prev,
              state: 'mixing',
              strategy: msg.strategy || prev.strategy || 'Stem Crossfade',
            }));
          } else if (msg.type === 'dj.transition.progress') {
            setTransition((prev) => ({
              ...prev,
              state: 'mixing',
              progress: msg.progress,
            }));
          } else if (msg.type === 'dj.transition.completed' || msg.type === 'transition.completed') {
            setTransition({ state: 'idle' });
          } else if (msg.type === 'dj.transition.fallback' || msg.type === 'transition.fallback') {
            setTransition((prev) => ({
              ...prev,
              state: 'fallback',
              strategy: `Fallback: ${msg.reason || 'Equal-power Crossfade'}`,
            }));
            setTimeout(() => setTransition({ state: 'idle' }), 5000);
          }
        } catch {
          // ignore
        }
      };
    } catch {
      // ws error
    }
    return () => {
      if (ws) ws.close();
    };
  }, [activeTrack?.name]);

  // Controls handlers
  const handlePlayPause = async () => {
    if (!guildId) return;
    setActionLoading(true);
    try {
      const endpoint = isPlaying
        ? `/api/playback/${guildId}/pause`
        : `/api/playback/${guildId}/resume`;
      await fetch(endpoint, { method: 'POST' });
    } catch {
      // ignore
    } finally {
      setActionLoading(false);
    }
  };

  const handleSkip = async () => {
    if (!guildId) return;
    setActionLoading(true);
    try {
      await fetch(`/api/playback/${guildId}/skip`, { method: 'POST' });
      onRefreshQueue?.();
    } catch {
      // ignore
    } finally {
      setActionLoading(false);
    }
  };

  const handleToggleFavorite = async () => {
    if (!activeTrack?.id) return;
    const nextState = !isFavorite;
    setIsFavorite(nextState); // optimistic
    try {
      if (nextState) {
        await fetch('/api/favorites', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ trackId: activeTrack.id }),
        });
      } else {
        await fetch(`/api/favorites/${activeTrack.id}`, { method: 'DELETE' });
      }
    } catch {
      setIsFavorite(!nextState); // rollback
    }
  };

  const handleVolumeChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVol = Number(e.target.value);
    setVolume(newVol);
    if (!guildId) return;
    try {
      await fetch(`/api/playback/${guildId}/volume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ volume: newVol }),
      });
      onRefreshSettings?.();
    } catch {
      // ignore
    }
  };

  const handleLoopToggle = async () => {
    if (!guildId) return;
    const modes: ('off' | 'track' | 'queue')[] = ['off', 'track', 'queue'];
    const nextMode = modes[(modes.indexOf(settings.loopMode) + 1) % modes.length];
    try {
      await fetch(`/api/playback/${guildId}/loop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: nextMode }),
      });
      onRefreshSettings?.();
    } catch {
      // ignore
    }
  };

  const duration = activeTrack?.duration || 0;
  const progressPercent = duration > 0 ? Math.min(100, (elapsedSeconds / duration) * 100) : 0;

  return (
    <div className="now-playing-card glass-panel" aria-label="Now Playing Media Player">
      {/* Header */}
      <div className="card-top-bar">
        <span className="card-badge">
          <span className={`status-indicator-dot ${isPlaying ? 'pulse' : ''}`} />
          {playback.playerState}
        </span>
        <button
          className={`favorite-btn ${isFavorite ? 'favorited' : ''}`}
          onClick={handleToggleFavorite}
          disabled={!activeTrack?.id}
          aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
          title={isFavorite ? 'Remove from favorites' : 'Save to favorites'}
        >
          {isFavorite ? '❤️' : '🤍'}
        </button>
      </div>

      {/* Main Track Display with Vinyl Animation */}
      <div className="now-playing-body">
        <div className="vinyl-wrapper">
          <div className={`vinyl-disc ${isPlaying ? 'spinning' : isPaused ? 'paused' : ''}`}>
            <div className="vinyl-grooves" />
            <div className="vinyl-label">
              {activeTrack?.artwork ? (
                <img src={activeTrack.artwork} alt="" className="vinyl-artwork" />
              ) : (
                <span className="vinyl-icon">🎵</span>
              )}
            </div>
          </div>
          {activeTrack?.artwork && (
            <img
              src={activeTrack.artwork}
              alt={activeTrack.name}
              className="album-art-underlay"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
          )}
        </div>

        <div className="track-text-details">
          <h2 className="now-playing-title" title={activeTrack?.name || 'No Track Playing'}>
            {activeTrack?.name || 'No Track Playing'}
          </h2>
          <p className="now-playing-artist">
            {activeTrack?.artist || 'Unknown Artist'}
            {activeTrack?.album && <span className="album-pill"> • {activeTrack.album}</span>}
          </p>
          {activeTrack?.source && (
            <span className={`source-badge source-${activeTrack.source}`}>
              {activeTrack.source === 'local' ? '📁 Local File' :
               activeTrack.source === 'soundcloud' ? '☁️ SoundCloud' :
               activeTrack.source === 'youtube' ? '▶️ YouTube' :
               activeTrack.source === 'spotify' ? '🎧 Spotify' :
               '🌐 Stream'}
            </span>
          )}
        </div>
      </div>

      {/* Transition Visualization Banner (Requirement 18) */}
      {transition.state !== 'idle' && (
        <div className={`transition-banner transition-${transition.state}`} role="status">
          <div className="transition-header">
            <span className="transition-tag">
              {transition.state === 'preparing' && '⏳ PREPARING TRANSITION'}
              {transition.state === 'ready' && '✨ TRANSITION READY'}
              {transition.state === 'mixing' && '🎛️ MIXING IN PROGRESS'}
              {transition.state === 'fallback' && '⚠️ TRANSITION FALLBACK'}
            </span>
            <span className="transition-strategy">{transition.strategy}</span>
          </div>
          <div className="transition-flow">
            <span className="flow-track current">{transition.fromTrack || activeTrack?.name || 'Current'}</span>
            <span className="flow-arrow">⬇</span>
            <span className="flow-track next">{transition.toTrack || 'Next'}</span>
          </div>
          {(transition.bpmChange || transition.keyChange) && (
            <div className="transition-metrics">
              {transition.bpmChange && <span className="metric-pill">🎵 {transition.bpmChange}</span>}
              {transition.keyChange && <span className="metric-pill">🎹 {transition.keyChange}</span>}
            </div>
          )}
        </div>
      )}

      {/* Progress Timeline Scrubber */}
      <div className="timeline-container">
        <div className="progress-bar-bg" role="progressbar" aria-valuenow={progressPercent} aria-valuemin={0} aria-valuemax={100}>
          <div className="progress-bar-fill" style={{ width: `${progressPercent}%` }}>
            <span className="progress-scrubber-handle" />
          </div>
        </div>
        <div className="timeline-timestamps">
          <span>{formatDuration(elapsedSeconds)}</span>
          <span>{formatDuration(duration)}</span>
        </div>
      </div>

      {/* Playback Controls (Requirement 17) */}
      <div className="playback-controls-row">
        <button
          className="control-btn"
          onClick={handleLoopToggle}
          aria-label={`Loop mode: ${settings.loopMode}`}
          title={`Loop: ${settings.loopMode.toUpperCase()}`}
        >
          {settings.loopMode === 'track' ? '🔂' : settings.loopMode === 'queue' ? '🔁' : '➡️'}
        </button>

        <button
          className="control-btn play-pause-btn"
          onClick={handlePlayPause}
          disabled={actionLoading || !activeTrack}
          aria-label={isPlaying ? 'Pause playback' : 'Resume playback'}
          title={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? '⏸' : '▶'}
        </button>

        <button
          className="control-btn skip-btn"
          onClick={handleSkip}
          disabled={actionLoading || !activeTrack}
          aria-label="Skip to next track"
          title="Skip"
        >
          ⏭
        </button>

        {/* Volume Slider */}
        <div className="volume-control-box" title={`Volume: ${volume}%`}>
          <span className="volume-icon">{volume === 0 ? '🔇' : volume < 50 ? '🔉' : '🔊'}</span>
          <input
            type="range"
            min={0}
            max={200}
            value={volume}
            onChange={handleVolumeChange}
            className="volume-slider"
            aria-label="Volume slider (0 to 200%)"
          />
          <span className="volume-label">{volume}%</span>
        </div>
      </div>
    </div>
  );
}
