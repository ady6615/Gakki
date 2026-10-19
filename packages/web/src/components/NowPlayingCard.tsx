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
  const trackTitle = activeTrack?.name || (activeTrack as any)?.title || 'No Track Playing';
  const trackArtist = activeTrack?.artist || 'Unknown Artist';
  const trackAlbum = activeTrack?.album || '';
  const trackArtwork = activeTrack?.artwork || (activeTrack as any)?.thumbnailUrl || (activeTrack as any)?.thumbnail || null;
  const duration = activeTrack?.duration || 0;

  const isPlaying = playback.playerState === 'PLAYING';
  const isPaused = playback.playerState === 'PAUSED';

  // Local progress ticker for smooth UI
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [isFavorite, setIsFavorite] = useState(false);
  const [volume, setVolume] = useState(settings.volume);
  const [prevVolume, setPrevVolume] = useState(settings.volume || 100);
  const [transition, setTransition] = useState<TransitionVisualState>({ state: 'idle' });
  const [actionLoading, setActionLoading] = useState(false);

  // Sync volume from settings
  useEffect(() => {
    setVolume(settings.volume);
    if (settings.volume > 0) {
      setPrevVolume(settings.volume);
    }
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
  }, [trackTitle]);

  useEffect(() => {
    if (!isPlaying) return;
    const interval = setInterval(() => {
      setElapsedSeconds((prev) => {
        if (duration && prev >= duration) {
          return prev;
        }
        return prev + 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [isPlaying, duration]);

  // Listen to WebSocket events for DJ transitions & live position ticks
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
              strategy: msg.strategy,
              fromTrack: msg.fromTrack,
              toTrack: msg.toTrack,
              bpmChange: msg.bpmChange,
              keyChange: msg.keyChange,
            });
          } else if (msg.type === 'dj.transition.started' || msg.type === 'transition.started') {
            setTransition((prev) => ({ ...prev, state: 'mixing', progress: 0 }));
          } else if (msg.type === 'dj.transition.completed' || msg.type === 'transition.completed') {
            setTransition({ state: 'idle' });
          } else if (msg.type === 'dj.transition.fallback' || msg.type === 'transition.fallback') {
            setTransition({ state: 'fallback', strategy: msg.reason });
            setTimeout(() => setTransition({ state: 'idle' }), 4000);
          } else if (msg.type === 'playback.position') {
            if (typeof msg.positionSeconds === 'number') {
              setElapsedSeconds(msg.positionSeconds);
            }
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
  }, [trackTitle]);

  // Controls handlers
  const handlePlayPause = async () => {
    if (!guildId) return;
    setActionLoading(true);
    try {
      const endpoint = isPlaying
        ? `/api/playback/${guildId}/pause`
        : `/api/playback/${guildId}/resume`;
      await fetch(endpoint, { method: 'POST' });
      onRefreshQueue?.();
      onRefreshSettings?.();
    } catch {
      // ignore
    } finally {
      setActionLoading(false);
    }
  };

  const handleStop = async () => {
    if (!guildId) return;
    setActionLoading(true);
    try {
      await fetch(`/api/playback/${guildId}/stop`, { method: 'POST' });
      setElapsedSeconds(0);
      onRefreshQueue?.();
      onRefreshSettings?.();
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
      setElapsedSeconds(0);
      onRefreshQueue?.();
      onRefreshSettings?.();
    } catch {
      // ignore
    } finally {
      setActionLoading(false);
    }
  };

  const handleRestart = async () => {
    await handleSeek(0, false);
  };

  const handleShuffle = async () => {
    if (!guildId) return;
    try {
      await fetch(`/api/playback/${guildId}/shuffle`, { method: 'POST' });
      onRefreshQueue?.();
    } catch {
      // ignore
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
    if (newVol > 0) setPrevVolume(newVol);
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

  const handleToggleMute = async () => {
    if (!guildId) return;
    const nextVol = volume > 0 ? 0 : (prevVolume > 0 ? prevVolume : 100);
    setVolume(nextVol);
    try {
      await fetch(`/api/playback/${guildId}/volume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ volume: nextVol }),
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

  const handleSeek = async (seconds: number, relative: boolean = false) => {
    if (!guildId || !activeTrack) return;
    try {
      const current = elapsedSeconds;
      const target = relative ? Math.max(0, current + seconds) : Math.max(0, seconds);
      const clamped = duration ? Math.min(target, Math.max(0, duration - 2)) : target;
      setElapsedSeconds(clamped);

      await fetch(`/api/playback/${guildId}/seek`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seconds, relative }),
      });
    } catch {
      // ignore
    }
  };

  const progressPercent = duration > 0 ? Math.min(100, (elapsedSeconds / duration) * 100) : 0;

  return (
    <div className="now-playing-card glass-panel" aria-label="Now Playing Media Player">
      {/* Header */}
      <div className="card-top-bar">
        <span className="card-badge">
          <span className={`status-indicator-dot ${isPlaying ? 'pulse' : ''}`} />
          {playback.playerState || 'IDLE'}
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
              {trackArtwork ? (
                <img src={trackArtwork} alt="" className="vinyl-artwork" />
              ) : (
                <img src="/logo-small.png" alt="Gakki Logo" className="vinyl-artwork vinyl-default-logo" />
              )}
            </div>
          </div>
          {trackArtwork && (
            <img
              src={trackArtwork}
              alt={trackTitle}
              className="album-art-underlay"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
          )}
        </div>

        <div className="track-text-details">
          <h2 className="now-playing-title" title={trackTitle}>
            {trackTitle}
          </h2>
          <p className="now-playing-artist">
            {trackArtist}
            {trackAlbum && <span className="album-pill"> • {trackAlbum}</span>}
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

      {/* Transition Visualization Banner */}
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
            <span className="flow-track current">{transition.fromTrack || trackTitle}</span>
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

      {/* Progress Timeline Scrubber with Clickable Seek */}
      <div className="timeline-container">
        <div
          className="progress-bar-bg clickable-scrubber"
          role="progressbar"
          aria-valuenow={progressPercent}
          aria-valuemin={0}
          aria-valuemax={100}
          onClick={(e) => {
            if (!duration || !activeTrack) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const clickX = e.clientX - rect.left;
            const ratio = Math.max(0, Math.min(1, clickX / rect.width));
            const targetSec = Math.floor(ratio * duration);
            handleSeek(targetSec, false);
          }}
          title="Click timeline to seek position"
        >
          <div className="progress-bar-fill" style={{ width: `${progressPercent}%` }}>
            <span className="progress-scrubber-handle" />
          </div>
        </div>
        <div className="timeline-timestamps">
          <span>{formatDuration(elapsedSeconds)}</span>
          <span>{formatDuration(duration)}</span>
        </div>
      </div>

      {/* Song Navigation Setting Control Row */}
      <div className="navigation-controls-row">
        <div className="nav-step-buttons">
          <button
            className="nav-btn"
            onClick={() => handleSeek(-30, true)}
            disabled={!activeTrack || actionLoading}
            title="Rewind 30 seconds"
            aria-label="Rewind 30 seconds"
          >
            ⏪ −30s
          </button>
          <button
            className="nav-btn"
            onClick={() => handleSeek(-10, true)}
            disabled={!activeTrack || actionLoading}
            title="Rewind 10 seconds"
            aria-label="Rewind 10 seconds"
          >
            ◀️ −10s
          </button>
          <button
            className="nav-btn"
            onClick={() => handleSeek(10, true)}
            disabled={!activeTrack || actionLoading}
            title="Skip forward 10 seconds"
            aria-label="Skip forward 10 seconds"
          >
            ▶️ +10s
          </button>
          <button
            className="nav-btn"
            onClick={() => handleSeek(30, true)}
            disabled={!activeTrack || actionLoading}
            title="Skip forward 30 seconds"
            aria-label="Skip forward 30 seconds"
          >
            ⏩ +30s
          </button>
        </div>

        <div className="nav-select-wrapper" title="Song Navigation Setting">
          <span className="nav-select-icon">🧭</span>
          <select
            className="nav-select-menu"
            disabled={!activeTrack || actionLoading}
            onChange={(e) => {
              const val = e.target.value;
              if (!val) return;
              if (val.startsWith('rel_')) {
                handleSeek(parseInt(val.replace('rel_', ''), 10), true);
              } else if (val === 'abs_0') {
                handleSeek(0, false);
              } else if (val.startsWith('pct_')) {
                const pct = parseInt(val.replace('pct_', ''), 10);
                const target = Math.floor(((duration || 0) * pct) / 100);
                handleSeek(target, false);
              }
              e.target.value = '';
            }}
            defaultValue=""
            aria-label="Song Navigation Setting"
          >
            <option value="" disabled>
              Navigate Song...
            </option>
            <option value="rel_-30">⏪ Rewind 30s</option>
            <option value="rel_-10">◀️ Rewind 10s</option>
            <option value="rel_10">▶️ Skip ahead 10s</option>
            <option value="rel_30">⏩ Skip ahead 30s</option>
            <option value="rel_60">⏭️ Skip ahead 60s</option>
            <option value="abs_0">⏮️ Restart song (0:00)</option>
            <option value="pct_25">¼ Jump to 25%</option>
            <option value="pct_50">½ Jump to 50% (Halfway)</option>
            <option value="pct_75">¾ Jump to 75%</option>
          </select>
        </div>
      </div>

      {/* Main Playback Controls */}
      <div className="playback-controls-row">
        <button
          className="control-btn"
          onClick={handleRestart}
          disabled={!activeTrack || actionLoading}
          aria-label="Restart song"
          title="Restart song (0:00)"
        >
          ⏮
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
          className="control-btn"
          onClick={handleStop}
          disabled={actionLoading || (!isPlaying && !isPaused)}
          aria-label="Stop playback"
          title="Stop playback"
        >
          ⏹
        </button>

        <button
          className="control-btn skip-btn"
          onClick={handleSkip}
          disabled={actionLoading || !activeTrack}
          aria-label="Skip to next track"
          title="Skip to next track"
        >
          ⏭
        </button>

        <button
          className={`control-btn ${settings.loopMode !== 'off' ? 'active-mode' : ''}`}
          onClick={handleLoopToggle}
          aria-label={`Loop mode: ${settings.loopMode}`}
          title={`Loop: ${settings.loopMode.toUpperCase()}`}
        >
          {settings.loopMode === 'track' ? '🔂' : settings.loopMode === 'queue' ? '🔁' : '➡️'}
        </button>

        <button
          className="control-btn"
          onClick={handleShuffle}
          disabled={!queueState.queue || queueState.queue.length <= 1}
          aria-label="Shuffle queue"
          title="Shuffle remaining queue"
        >
          🔀
        </button>

        {/* Volume & Mute Control */}
        <div className="volume-control-box" title={`Volume: ${volume}%`}>
          <button
            type="button"
            className="volume-mute-btn"
            onClick={handleToggleMute}
            aria-label={volume === 0 ? 'Unmute volume' : 'Mute volume'}
            title={volume === 0 ? 'Unmute' : 'Mute'}
          >
            {volume === 0 ? '🔇' : volume < 50 ? '🔉' : '🔊'}
          </button>
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
