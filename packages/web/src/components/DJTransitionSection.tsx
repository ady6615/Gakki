import { useEffect, useState, useRef } from 'react';

export interface TransitionSettings {
  guildId: string;
  transitionEnabled: boolean;
  transitionDuration: number;
  transitionProfile: 'SMOOTH' | 'BALANCED' | 'ENERGETIC';
  harmonicMixing: boolean;
  autoTempo: boolean;
  loudnessNormalize: boolean;
}

export interface TransitionCapabilities {
  acrossfade: boolean;
  rubberband: boolean;
  loudnorm: boolean;
  atempo: boolean;
}

export interface TransitionPreview {
  available: boolean;
  message?: string;
  currentTrack?: {
    id: string;
    name: string;
    artist?: string | null;
    duration?: number | null;
    key?: string | null;
    camelot?: string | null;
    lufs?: number | null;
  };
  nextTrack?: {
    id: string;
    name: string;
    artist?: string | null;
    duration?: number | null;
    key?: string | null;
    camelot?: string | null;
    lufs?: number | null;
  };
  plan?: {
    durationSeconds: number;
    profile: string;
    curve: string;
    fallbackLevel: string;
    score: number;
    outgoingCueSeconds: number;
    incomingCueSeconds: number;
    tempoAdjustmentPercent: number;
    pitchShiftSemitones: number;
    explanation: string;
  };
}

export function DJTransitionSection() {
  const [guildId, setGuildId] = useState<string>('default-guild');
  const [settings, setSettings] = useState<TransitionSettings>({
    guildId: 'default-guild',
    transitionEnabled: true,
    transitionDuration: 6,
    transitionProfile: 'BALANCED',
    harmonicMixing: true,
    autoTempo: true,
    loudnessNormalize: true,
  });

  const [capabilities, setCapabilities] = useState<TransitionCapabilities | null>(null);
  const [preview, setPreview] = useState<TransitionPreview | null>(null);
  const [activeTransitionEvent, setActiveTransitionEvent] = useState<string | null>(null);
  const [saving, setSaving] = useState<boolean>(false);
  const wsRef = useRef<WebSocket | null>(null);

  // 1. Initial Data Fetch
  useEffect(() => {
    const initData = async () => {
      try {
        const pbRes = await fetch('/api/playback');
        let activeGuild = 'default-guild';
        if (pbRes.ok) {
          const pbData = await pbRes.json();
          activeGuild = pbData.primary?.guildId || pbData.guildId || 'default-guild';
          setGuildId(activeGuild);
        }

        // Fetch settings & capabilities
        const transRes = await fetch(`/api/guilds/${activeGuild}/transition`);
        if (transRes.ok) {
          const transData = await transRes.json();
          if (transData.settings) setSettings(transData.settings);
          if (transData.capabilities) setCapabilities(transData.capabilities);
        }

        // Fetch preview
        const prevRes = await fetch(`/api/guilds/${activeGuild}/transition/preview`);
        if (prevRes.ok) {
          const prevData = await prevRes.json();
          setPreview(prevData);
        }
      } catch {
        // Fallback for offline mode
      }
    };

    initData();
  }, []);

  // 2. WebSocket Listener for Transition Lifecycle Events
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    const connectWs = () => {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type?.startsWith('transition.')) {
            if (data.type === 'transition.preparing') {
              setActiveTransitionEvent('Preparing next track transition in background...');
            } else if (data.type === 'transition.ready') {
              setActiveTransitionEvent(
                `Transition pre-buffered & ready (cue at ${data.cueSeconds}s, ${(data.score * 100).toFixed(0)}% score)`,
              );
            } else if (data.type === 'transition.started') {
              setActiveTransitionEvent(`Crossfading tracks (${data.durationMs / 1000}s ${data.profile})...`);
            } else if (data.type === 'transition.completed') {
              setActiveTransitionEvent('Transition completed seamlessly!');
              setTimeout(() => setActiveTransitionEvent(null), 4000);
            } else if (data.type === 'transition.fallback') {
              setActiveTransitionEvent(`Transition fallback applied: ${data.reason}`);
            } else if (data.type === 'transition.failed') {
              setActiveTransitionEvent(`Transition failed: ${data.error}`);
              setTimeout(() => setActiveTransitionEvent(null), 4000);
            }

            // Refresh preview
            fetch(`/api/guilds/${guildId}/transition/preview`)
              .then((r) => r.json())
              .then((d) => setPreview(d))
              .catch(() => {});
          }
        } catch {}
      };

      ws.onerror = () => ws.close();
      ws.onclose = () => {
        setTimeout(connectWs, 3000);
      };
    };

    connectWs();
    return () => {
      wsRef.current?.close();
    };
  }, [guildId]);

  // Update Settings Handler
  const updateSettings = async (updates: Partial<TransitionSettings>) => {
    const newSettings = { ...settings, ...updates };
    setSettings(newSettings);
    setSaving(true);
    try {
      const res = await fetch(`/api/guilds/${guildId}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.settings) setSettings(data.settings);
      }
    } catch {}
    setSaving(false);
  };

  return (
    <section className="card dj-transition-section">
      <div className="card-header flex justify-between items-center">
        <div className="flex items-center gap-2">
          <span className="card-icon text-xl">🎚️</span>
          <div>
            <h2 className="card-title">DJ TRANSITIONS</h2>
            <p className="card-subtitle text-xs text-muted">
              Equal-Power Crossfading, Harmonic Mixing & EBU R128 Loudness
            </p>
          </div>
        </div>

        <button
          className={`toggle-btn ${settings.transitionEnabled ? 'active' : ''}`}
          onClick={() => updateSettings({ transitionEnabled: !settings.transitionEnabled })}
          disabled={saving}
        >
          {settings.transitionEnabled ? 'ON' : 'OFF'}
        </button>
      </div>

      {activeTransitionEvent && (
        <div className="transition-status-banner">
          <span className="pulse-indicator">●</span>
          <span>{activeTransitionEvent}</span>
        </div>
      )}

      {/* Control Area */}
      <div className="transition-controls-grid">
        {/* Profile Selector */}
        <div className="control-group">
          <label className="control-label">Profile</label>
          <div className="profile-radio-group">
            {(['SMOOTH', 'BALANCED', 'ENERGETIC'] as const).map((p) => (
              <button
                key={p}
                className={`profile-pill ${settings.transitionProfile === p ? 'active' : ''}`}
                onClick={() => updateSettings({ transitionProfile: p })}
              >
                {p.charAt(0) + p.slice(1).toLowerCase()}
              </button>
            ))}
          </div>
        </div>

        {/* Crossfade Duration Slider */}
        <div className="control-group">
          <div className="flex justify-between items-center">
            <label className="control-label">Crossfade Duration</label>
            <span className="duration-badge">{settings.transitionDuration} sec</span>
          </div>
          <input
            type="range"
            min="1"
            max="8"
            step="1"
            value={settings.transitionDuration}
            onChange={(e) => updateSettings({ transitionDuration: parseInt(e.target.value, 10) })}
            className="slider"
          />
          <div className="slider-ticks flex justify-between text-xs text-muted">
            <span>1s</span>
            <span>4s</span>
            <span>8s</span>
          </div>
        </div>

        {/* Feature Toggles */}
        <div className="control-group toggles-row">
          <div className="toggle-item">
            <span className="toggle-label">Harmonic Mixing</span>
            <button
              className={`mini-toggle ${settings.harmonicMixing ? 'active' : ''}`}
              onClick={() => updateSettings({ harmonicMixing: !settings.harmonicMixing })}
            >
              {settings.harmonicMixing ? 'ON' : 'OFF'}
            </button>
          </div>

          <div className="toggle-item">
            <span className="toggle-label">Auto Tempo</span>
            <button
              className={`mini-toggle ${settings.autoTempo ? 'active' : ''}`}
              onClick={() => updateSettings({ autoTempo: !settings.autoTempo })}
            >
              {settings.autoTempo ? 'ON' : 'OFF'}
            </button>
          </div>

          <div className="toggle-item">
            <span className="toggle-label">Loudness Normalize</span>
            <button
              className={`mini-toggle ${settings.loudnessNormalize ? 'active' : ''}`}
              onClick={() => updateSettings({ loudnessNormalize: !settings.loudnessNormalize })}
            >
              {settings.loudnessNormalize ? 'ON' : 'OFF'}
            </button>
          </div>
        </div>
      </div>

      {/* Dynamic Preview: CURRENT -> NEXT */}
      <div className="transition-preview-box">
        <div className="preview-header">CURRENT → NEXT TRANSITION</div>

        {preview && preview.available && preview.currentTrack && preview.nextTrack ? (
          <div className="flow-container">
            {/* Outgoing Track */}
            <div className="track-card outgoing">
              <div className="track-role">OUTGOING</div>
              <div className="track-title">{preview.currentTrack.name}</div>
              <div className="track-artist">{preview.currentTrack.artist || 'Unknown Artist'}</div>
              <div className="track-tags">
                {preview.currentTrack.camelot && (
                  <span className="tag camelot">{preview.currentTrack.camelot}</span>
                )}
                {typeof preview.currentTrack.lufs === 'number' && (
                  <span className="tag lufs">{preview.currentTrack.lufs.toFixed(1)} LUFS</span>
                )}
              </div>
            </div>

            {/* Transition Center Badge */}
            <div className="transition-arrow">
              <div className="arrow-down">↓</div>
              <div className="transition-pill">
                <span className="pill-duration">{preview.plan?.durationSeconds}s</span>
                <span className="pill-curve">{preview.plan?.curve.toUpperCase()}</span>
                <span className="pill-score">
                  {((preview.plan?.score || 0) * 100).toFixed(0)}% Match
                </span>
              </div>
              <div className="arrow-down">↓</div>
            </div>

            {/* Incoming Track */}
            <div className="track-card incoming">
              <div className="track-role">INCOMING</div>
              <div className="track-title">{preview.nextTrack.name}</div>
              <div className="track-artist">{preview.nextTrack.artist || 'Unknown Artist'}</div>
              <div className="track-tags">
                {preview.nextTrack.camelot && (
                  <span className="tag camelot">{preview.nextTrack.camelot}</span>
                )}
                {typeof preview.nextTrack.lufs === 'number' && (
                  <span className="tag lufs">{preview.nextTrack.lufs.toFixed(1)} LUFS</span>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="no-preview-notice">
            <span>ℹ️</span> {preview?.message || 'Add tracks to queue to preview upcoming transitions'}
          </div>
        )}
      </div>

      {/* Capabilities Footer */}
      {capabilities && (
        <div className="capabilities-footer">
          <span className="cap-label">FFmpeg Audio DSP:</span>
          <span className={`cap-tag ${capabilities.rubberband ? 'good' : 'warn'}`}>
            librubberband: {capabilities.rubberband ? '✓ Active' : '✗ Unavailable'}
          </span>
          <span className={`cap-tag ${capabilities.acrossfade ? 'good' : 'warn'}`}>
            acrossfade: {capabilities.acrossfade ? '✓ Active' : '✗'}
          </span>
          <span className={`cap-tag ${capabilities.loudnorm ? 'good' : 'warn'}`}>
            loudnorm (EBU R128): {capabilities.loudnorm ? '✓ Active' : '✗'}
          </span>
        </div>
      )}
    </section>
  );
}
