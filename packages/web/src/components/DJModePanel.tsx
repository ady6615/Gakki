import { useState, useEffect } from 'react';

interface DJModePanelProps {
  guildId: string;
}

export function DJModePanel({ guildId }: DJModePanelProps) {
  const [enabled, setEnabled] = useState(true);
  const [profile, setProfile] = useState<'BALANCED' | 'CHILL' | 'ENERGETIC'>('BALANCED');
  const [crossfadeSec, setCrossfadeSec] = useState(6);
  const [harmonicMixing, setHarmonicMixing] = useState(true);
  const [vocalProtection, setVocalProtection] = useState(true);
  const [autoTempo, setAutoTempo] = useState(true);
  const [saving, setSaving] = useState(false);

  // Fetch current guild transition and stem settings
  useEffect(() => {
    if (!guildId) return;

    fetch(`/api/guilds/${guildId}/transition`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.settings) {
          setEnabled(Boolean(data.settings.transitionEnabled));
          if (data.settings.transitionProfile) {
            setProfile(data.settings.transitionProfile.toUpperCase());
          }
          if (data.settings.transitionDuration != null) {
            setCrossfadeSec(data.settings.transitionDuration);
          }
          if (data.settings.harmonicMixing !== undefined) {
            setHarmonicMixing(Boolean(data.settings.harmonicMixing));
          }
          if (data.settings.autoTempo !== undefined) {
            setAutoTempo(Boolean(data.settings.autoTempo));
          }
        }
      })
      .catch(() => {});

    fetch(`/api/stems/guilds/${guildId}/settings`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.settings?.vocalClashPrevention !== undefined) {
          setVocalProtection(Boolean(data.settings.vocalClashPrevention));
        }
      })
      .catch(() => {});
  }, [guildId]);

  const updateTransitionSettings = async (changes: Record<string, any>) => {
    if (!guildId) return;
    setSaving(true);
    try {
      await fetch(`/api/guilds/${guildId}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changes),
      });
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  };

  const updateStemSettings = async (changes: Record<string, any>) => {
    if (!guildId) return;
    setSaving(true);
    try {
      await fetch(`/api/stems/guilds/${guildId}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changes),
      });
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  };

  const handleToggleEnabled = () => {
    const next = !enabled;
    setEnabled(next);
    updateTransitionSettings({ transitionEnabled: next });
  };

  const handleProfileChange = (newProfile: 'BALANCED' | 'CHILL' | 'ENERGETIC') => {
    setProfile(newProfile);
    updateTransitionSettings({ transitionProfile: newProfile.toLowerCase() });
  };

  const handleCrossfadeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = Number(e.target.value);
    setCrossfadeSec(val);
    updateTransitionSettings({ transitionDuration: val });
  };

  const handleToggleHarmonic = () => {
    const next = !harmonicMixing;
    setHarmonicMixing(next);
    updateTransitionSettings({ harmonicMixing: next });
  };

  const handleToggleVocalProtection = () => {
    const next = !vocalProtection;
    setVocalProtection(next);
    updateStemSettings({ vocalClashPrevention: next });
  };

  const handleToggleAutoTempo = () => {
    const next = !autoTempo;
    setAutoTempo(next);
    updateTransitionSettings({ autoTempo: next });
  };

  return (
    <section className="dj-mode-panel glass-panel" aria-label="DJ Mode Configuration">
      <div className="dj-mode-header">
        <div className="dj-mode-title-row">
          <h3 className="dj-mode-heading">
            <span className="dj-icon">🎛️</span> DJ MODE
          </h3>
          <span className={`dj-status-dot ${enabled ? 'active' : 'inactive'}`} />
          {saving && <span style={{ fontSize: '0.72rem', color: '#c084fc' }}>Syncing...</span>}
        </div>
        <button
          className={`toggle-switch-btn ${enabled ? 'active' : ''}`}
          onClick={handleToggleEnabled}
          aria-label={enabled ? 'Disable DJ Mode' : 'Enable DJ Mode'}
          aria-pressed={enabled}
        >
          {enabled ? '● Enabled' : '○ Disabled'}
        </button>
      </div>

      <div className="dj-mode-controls-grid">
        {/* Profile */}
        <div className="dj-control-group">
          <label className="control-label" htmlFor="dj-profile-select">Profile</label>
          <div className="profile-pill-selector" id="dj-profile-select" role="radiogroup" aria-label="DJ Profile">
            {(['BALANCED', 'CHILL', 'ENERGETIC'] as const).map((p) => (
              <button
                key={p}
                className={`profile-pill ${profile === p ? 'selected' : ''}`}
                onClick={() => handleProfileChange(p)}
                role="radio"
                aria-checked={profile === p}
              >
                {p === 'BALANCED' ? 'Balanced' : p === 'CHILL' ? 'Chill' : 'Energetic'}
              </button>
            ))}
          </div>
        </div>

        {/* Crossfade */}
        <div className="dj-control-group">
          <div className="label-with-value">
            <label className="control-label" htmlFor="crossfade-slider">Crossfade</label>
            <span className="control-val">{crossfadeSec} sec</span>
          </div>
          <input
            id="crossfade-slider"
            type="range"
            min={0}
            max={15}
            step={1}
            value={crossfadeSec}
            onChange={handleCrossfadeChange}
            className="dj-slider"
            aria-label="Crossfade duration in seconds"
          />
        </div>

        {/* Toggles */}
        <div className="dj-toggles-row">
          <div className="dj-toggle-item">
            <span className="toggle-title">Harmonic Mixing</span>
            <button
              className={`mini-toggle-btn ${harmonicMixing ? 'on' : 'off'}`}
              onClick={handleToggleHarmonic}
              aria-label={`Harmonic mixing ${harmonicMixing ? 'ON' : 'OFF'}`}
              aria-pressed={harmonicMixing}
            >
              {harmonicMixing ? 'ON' : 'OFF'}
            </button>
          </div>

          <div className="dj-toggle-item">
            <span className="toggle-title">Vocal Protection</span>
            <button
              className={`mini-toggle-btn ${vocalProtection ? 'on' : 'off'}`}
              onClick={handleToggleVocalProtection}
              aria-label={`Vocal protection ${vocalProtection ? 'ON' : 'OFF'}`}
              aria-pressed={vocalProtection}
            >
              {vocalProtection ? 'ON' : 'OFF'}
            </button>
          </div>

          <div className="dj-toggle-item">
            <span className="toggle-title">Auto Tempo</span>
            <button
              className={`mini-toggle-btn ${autoTempo ? 'on' : 'off'}`}
              onClick={handleToggleAutoTempo}
              aria-label={`Auto tempo ${autoTempo ? 'ON' : 'OFF'}`}
              aria-pressed={autoTempo}
            >
              {autoTempo ? 'ON' : 'OFF'}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
