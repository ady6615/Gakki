import { useEffect, useState, useRef } from 'react';

export interface StemSettings {
  guildId: string;
  stemSeparationEnabled: boolean;
  vocalClashPrevention: boolean;
  vocalDucking: boolean;
  vocalDuckDb: number;
  layeredTransitions: boolean;
  stemProviderPreference: string;
}

export interface StemCapabilities {
  [name: string]: {
    name: string;
    available: boolean;
    supportedModels: string[];
    computeBackend: string;
    supports4Stems?: boolean;
    statusExplanation: string;
  };
}

export interface LiveTransitionState {
  currentTrackName: string;
  nextTrackName: string;
  strategy: string;
  vocalClashScore: number;
  vocalClashRisk: 'LOW' | 'MODERATE' | 'HIGH';
  currentBpm?: number | null;
  nextBpm?: number | null;
  currentKey?: string | null;
  nextKey?: string | null;
  activeDuckingDb?: number | null;
  status: 'idle' | 'preparing' | 'ducking' | 'layered' | 'completed';
}

export function StemMixingSection() {
  const [guildId] = useState<string>('default-guild');
  const [settings, setSettings] = useState<StemSettings>({
    guildId: 'default-guild',
    stemSeparationEnabled: true,
    vocalClashPrevention: true,
    vocalDucking: true,
    vocalDuckDb: 6.0,
    layeredTransitions: true,
    stemProviderPreference: 'auto',
  });

  const [capabilities, setCapabilities] = useState<StemCapabilities | null>(null);
  const [_loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  const [liveTransition, setLiveTransition] = useState<LiveTransitionState>({
    currentTrackName: 'After Dark',
    nextTrackName: 'Nightcall',
    strategy: 'Vocal Ducking',
    vocalClashScore: 0.78,
    vocalClashRisk: 'HIGH',
    currentBpm: 122,
    nextBpm: 124,
    currentKey: '8A (Am)',
    nextKey: '9A (Em)',
    activeDuckingDb: 6.0,
    status: 'ducking',
  });

  const wsRef = useRef<WebSocket | null>(null);

  // Fetch initial capabilities and settings
  useEffect(() => {
    fetchCapabilities();
    fetchSettings(guildId);
  }, [guildId]);

  // Connect to WebSocket for live transition events
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'transition.strategy.selected') {
            setLiveTransition((prev) => ({
              ...prev,
              strategy: formatStrategy(data.strategy),
              vocalClashScore: data.vocalClashScore ?? prev.vocalClashScore,
              vocalClashRisk:
                data.vocalClashScore >= 0.6 ? 'HIGH' : data.vocalClashScore >= 0.3 ? 'MODERATE' : 'LOW',
            }));
          } else if (data.type === 'transition.ducking.started') {
            setLiveTransition((prev) => ({
              ...prev,
              status: 'ducking',
              activeDuckingDb: data.duckDb ?? 6.0,
            }));
          } else if (data.type === 'transition.layered.started') {
            setLiveTransition((prev) => ({
              ...prev,
              status: 'layered',
            }));
          } else if (data.type === 'transition.completed') {
            setLiveTransition((prev) => ({
              ...prev,
              status: 'completed',
            }));
          }
        } catch {}
      };

      return () => {
        ws.close();
      };
    } catch {}
  }, []);

  const formatStrategy = (s: string) => {
    switch (s) {
      case 'VOCAL_DUCK':
        return 'Vocal Ducking';
      case 'INSTRUMENTAL_OUTRO_TO_VOCAL_INTRO':
        return 'Instrumental Outro → Vocal Intro (Layered)';
      case 'ACAPELLA_BRIDGE':
        return 'Acapella Bridge';
      case 'NORMAL_CROSSFADE':
        return 'Stem-Aware Crossfade';
      case 'FULL_MIX':
        return 'Full Mix';
      default:
        return s;
    }
  };

  const fetchCapabilities = async () => {
    try {
      const res = await fetch('/api/stems/capabilities');
      if (res.ok) {
        const data = await res.json();
        if (data.capabilities) {
          setCapabilities(data.capabilities);
        }
      }
    } catch {}
  };

  const fetchSettings = async (id: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/stems/guilds/${id}/settings`);
      if (res.ok) {
        const data = await res.json();
        if (data.settings) {
          setSettings(data.settings);
        }
      }
    } catch {} finally {
      setLoading(false);
    }
  };

  const updateSetting = async <K extends keyof StemSettings>(key: K, value: StemSettings[K]) => {
    const updated = { ...settings, [key]: value };
    setSettings(updated);
    setSaving(true);
    setMsg(null);

    try {
      const res = await fetch(`/api/stems/guilds/${guildId}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: value }),
      });

      if (res.ok) {
        setMsg({ text: 'Stem mixing settings saved', type: 'success' });
      } else {
        setMsg({ text: 'Failed to save settings', type: 'error' });
      }
    } catch {
      setMsg({ text: 'Network error saving settings', type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const clashBadgeColor =
    liveTransition.vocalClashRisk === 'HIGH'
      ? '#e74c3c'
      : liveTransition.vocalClashRisk === 'MODERATE'
      ? '#f39c12'
      : '#2ecc71';

  return (
    <section className="card stem-mixing-section" style={{ marginTop: '24px' }}>
      <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span>🎛️</span> STEM MIXING & VOCAL CLASH PREVENTION
          </h2>
          <p className="card-subtitle" style={{ margin: '4px 0 0 0', color: '#95a5a6' }}>
            Phase 9 Source Separation, Vocal Ducking & Layered DJ Transitions
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {saving && <span style={{ fontSize: '12px', color: '#3498db' }}>Saving...</span>}
          {msg && (
            <span style={{ fontSize: '12px', color: msg.type === 'success' ? '#2ecc71' : '#e74c3c' }}>
              {msg.text}
            </span>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '20px', marginTop: '16px' }}>
        {/* Controls Column */}
        <div style={{ background: 'rgba(255, 255, 255, 0.03)', borderRadius: '8px', padding: '16px', border: '1px solid rgba(255, 255, 255, 0.08)' }}>
          <h3 style={{ fontSize: '14px', textTransform: 'uppercase', letterSpacing: '1px', color: '#bdc3c7', marginBottom: '16px' }}>
            Engine Controls
          </h3>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            {/* Toggle 1: Stem Separation */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <strong>Stem Separation</strong>
                <div style={{ fontSize: '12px', color: '#7f8c8d' }}>Canonical 4-stem demixing</div>
              </div>
              <button
                className={`button ${settings.stemSeparationEnabled ? 'button-primary' : 'button-secondary'}`}
                style={{ minWidth: '70px', fontWeight: 'bold' }}
                onClick={() => updateSetting('stemSeparationEnabled', !settings.stemSeparationEnabled)}
              >
                {settings.stemSeparationEnabled ? 'ON' : 'OFF'}
              </button>
            </div>

            {/* Toggle 2: Vocal Clash Prevention */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <strong>Vocal Clash Prevention</strong>
                <div style={{ fontSize: '12px', color: '#7f8c8d' }}>Detects vocal overlap windows</div>
              </div>
              <button
                className={`button ${settings.vocalClashPrevention ? 'button-primary' : 'button-secondary'}`}
                style={{ minWidth: '70px', fontWeight: 'bold' }}
                onClick={() => updateSetting('vocalClashPrevention', !settings.vocalClashPrevention)}
              >
                {settings.vocalClashPrevention ? 'ON' : 'OFF'}
              </button>
            </div>

            {/* Toggle 3: Vocal Ducking */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <strong>Vocal Ducking</strong>
                <div style={{ fontSize: '12px', color: '#7f8c8d' }}>Ducks outgoing vocals only</div>
              </div>
              <button
                className={`button ${settings.vocalDucking ? 'button-primary' : 'button-secondary'}`}
                style={{ minWidth: '70px', fontWeight: 'bold' }}
                onClick={() => updateSetting('vocalDucking', !settings.vocalDucking)}
              >
                {settings.vocalDucking ? 'ON' : 'OFF'}
              </button>
            </div>

            {/* Toggle 4: Layered Transitions */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <strong>Layered Transitions</strong>
                <div style={{ fontSize: '12px', color: '#7f8c8d' }}>Instrumental outro + Vocal intro</div>
              </div>
              <button
                className={`button ${settings.layeredTransitions ? 'button-primary' : 'button-secondary'}`}
                style={{ minWidth: '70px', fontWeight: 'bold' }}
                onClick={() => updateSetting('layeredTransitions', !settings.layeredTransitions)}
              >
                {settings.layeredTransitions ? 'ON' : 'OFF'}
              </button>
            </div>

            {/* Slider: Duck Amount */}
            <div style={{ marginTop: '8px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                <span style={{ fontSize: '13px', fontWeight: 600 }}>Duck Amount</span>
                <span style={{ fontSize: '13px', color: '#3498db', fontWeight: 'bold' }}>
                  {settings.vocalDuckDb.toFixed(1)} dB
                </span>
              </div>
              <input
                type="range"
                min="3.0"
                max="12.0"
                step="0.5"
                value={settings.vocalDuckDb}
                onChange={(e) => updateSetting('vocalDuckDb', parseFloat(e.target.value))}
                style={{ width: '100%', accentColor: '#3498db' }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#7f8c8d' }}>
                <span>Light (3 dB)</span>
                <span>Standard (6 dB)</span>
                <span>Heavy (12 dB)</span>
              </div>
            </div>
          </div>
        </div>

        {/* Live Transition Info Column */}
        <div style={{ background: 'rgba(255, 255, 255, 0.03)', borderRadius: '8px', padding: '16px', border: '1px solid rgba(255, 255, 255, 0.08)' }}>
          <h3 style={{ fontSize: '14px', textTransform: 'uppercase', letterSpacing: '1px', color: '#bdc3c7', marginBottom: '16px' }}>
            Current Transition Information
          </h3>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '16px' }}>
            <div style={{ padding: '10px', background: 'rgba(0,0,0,0.2)', borderRadius: '6px', minWidth: 0, overflow: 'hidden' }}>
              <div style={{ fontSize: '11px', color: '#7f8c8d', textTransform: 'uppercase' }}>CURRENT</div>
              <div style={{ fontWeight: 'bold', fontSize: '14px', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={liveTransition.currentTrackName}>
                {liveTransition.currentTrackName}
              </div>
            </div>

            <div style={{ padding: '10px', background: 'rgba(0,0,0,0.2)', borderRadius: '6px', minWidth: 0, overflow: 'hidden' }}>
              <div style={{ fontSize: '11px', color: '#7f8c8d', textTransform: 'uppercase' }}>NEXT</div>
              <div style={{ fontWeight: 'bold', fontSize: '14px', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={liveTransition.nextTrackName}>
                {liveTransition.nextTrackName}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: 'rgba(0,0,0,0.15)', borderRadius: '4px' }}>
              <span style={{ color: '#bdc3c7', fontSize: '13px' }}>Transition:</span>
              <strong style={{ color: '#2ecc71' }}>{liveTransition.strategy}</strong>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: 'rgba(0,0,0,0.15)', borderRadius: '4px' }}>
              <span style={{ color: '#bdc3c7', fontSize: '13px' }}>Vocal overlap risk:</span>
              <span style={{ background: clashBadgeColor, color: '#fff', padding: '2px 8px', borderRadius: '4px', fontSize: '12px', fontWeight: 'bold' }}>
                {liveTransition.vocalClashRisk} ({(liveTransition.vocalClashScore * 100).toFixed(0)}%)
              </span>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: 'rgba(0,0,0,0.15)', borderRadius: '4px' }}>
              <span style={{ color: '#bdc3c7', fontSize: '13px' }}>Tempo:</span>
              <span style={{ fontWeight: 'bold' }}>
                {liveTransition.currentBpm} → {liveTransition.nextBpm} BPM
              </span>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: 'rgba(0,0,0,0.15)', borderRadius: '4px' }}>
              <span style={{ color: '#bdc3c7', fontSize: '13px' }}>Key:</span>
              <span style={{ fontWeight: 'bold' }}>
                {liveTransition.currentKey} → {liveTransition.nextKey}
              </span>
            </div>
          </div>
        </div>

        {/* Separation Providers & Hardware Status */}
        <div style={{ background: 'rgba(255, 255, 255, 0.03)', borderRadius: '8px', padding: '16px', border: '1px solid rgba(255, 255, 255, 0.08)' }}>
          <h3 style={{ fontSize: '14px', textTransform: 'uppercase', letterSpacing: '1px', color: '#bdc3c7', marginBottom: '16px' }}>
            Provider Capabilities
          </h3>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {capabilities ? (
              Object.entries(capabilities).map(([name, cap]) => (
                <div key={name} style={{ padding: '10px', background: 'rgba(0,0,0,0.2)', borderRadius: '6px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                    <strong style={{ textTransform: 'uppercase' }}>{name}</strong>
                    <span style={{ fontSize: '11px', padding: '2px 6px', borderRadius: '4px', background: cap.available ? '#27ae60' : '#7f8c8d' }}>
                      {cap.available ? 'AVAILABLE' : 'UNAVAILABLE'}
                    </span>
                  </div>
                  <div style={{ fontSize: '12px', color: '#bdc3c7' }}>
                    Backend: <strong>{cap.computeBackend.toUpperCase()}</strong> | 4-Stems: <strong>{cap.supports4Stems ? 'Yes' : 'No'}</strong>
                  </div>
                  <div style={{ fontSize: '11px', color: '#7f8c8d', marginTop: '2px' }}>{cap.statusExplanation}</div>
                </div>
              ))
            ) : (
              <div style={{ color: '#7f8c8d', fontSize: '13px' }}>Inspecting runtime backends...</div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
