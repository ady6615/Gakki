import React, { useState, useEffect } from 'react';

export interface AudioDevice {
  id: string;
  name: string;
  type: 'output' | 'input';
  sampleRate?: number;
  channelCount?: number;
  isDefault?: boolean;
  isVirtual?: boolean;
}

export type PlaybackTarget = 'discord' | 'desktop' | 'virtual';

export interface AudioRoutingState {
  target: PlaybackTarget;
  outputDeviceId: string;
  inputDeviceId: string;
  monitoringEnabled: boolean;
  monitorDeviceId: string;
  activeOutputs: AudioDevice[];
  activeInputs: AudioDevice[];
}

interface AudioRoutingSectionProps {
  onRefresh?: () => void;
}

export function AudioRoutingSection({ onRefresh }: AudioRoutingSectionProps) {
  const [target, setTarget] = useState<PlaybackTarget>('desktop');
  const [outputDevices, setOutputDevices] = useState<AudioDevice[]>([]);
  const [inputDevices, setInputDevices] = useState<AudioDevice[]>([]);
  const [activeOutputId, setActiveOutputId] = useState<string>('');
  const [activeInputId, setActiveInputId] = useState<string>('');
  const [monitoringEnabled, setMonitoringEnabled] = useState<boolean>(false);
  const [monitorDeviceId, setMonitorDeviceId] = useState<string>('');
  const [fallbackMessage, setFallbackMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [showSetupGuide, setShowSetupGuide] = useState<boolean>(false);
  const [logPath, setLogPath] = useState<string>('');

  const isDesktop = Boolean(window.gakkiDesktop?.isDesktop);

  // Fetch initial devices & routing state from backend
  const fetchAudioState = async () => {
    try {
      const res = await fetch('/api/audio/devices');
      if (res.ok) {
        const data = await res.json();
        if (data.state) {
          setTarget(data.state.target || 'desktop');
          setActiveOutputId(data.state.outputDeviceId || '');
          setActiveInputId(data.state.inputDeviceId || '');
          setMonitoringEnabled(Boolean(data.state.monitoringEnabled));
          setMonitorDeviceId(data.state.monitorDeviceId || '');
        }
        if (data.outputs) {
          setOutputDevices(data.outputs);
        }
        if (data.inputs) {
          setInputDevices(data.inputs);
        }
      }
    } catch {
      // Fallback or offline
    }
  };

  useEffect(() => {
    fetchAudioState();

    if (window.gakkiDesktop?.logs?.getLogPath) {
      window.gakkiDesktop.logs.getLogPath().then((p: string) => setLogPath(p));
    }

    // Listen to browser MediaDevices hotplug changes if in Electron / Chromium
    if (navigator.mediaDevices && navigator.mediaDevices.ondevicechange !== undefined) {
      navigator.mediaDevices.ondevicechange = () => {
        fetchAudioState();
      };
    }
  }, []);

  // Listen to WebSocket audio routing updates
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'audio.routing.updated' && msg.state) {
            setTarget(msg.state.target);
            setActiveOutputId(msg.state.outputDeviceId);
            setActiveInputId(msg.state.inputDeviceId);
            setMonitoringEnabled(msg.state.monitoringEnabled);
            setMonitorDeviceId(msg.state.monitorDeviceId);
            if (msg.state.activeOutputs) setOutputDevices(msg.state.activeOutputs);
            if (msg.state.activeInputs) setInputDevices(msg.state.activeInputs);
          }
        } catch {
          // ignore
        }
      };
    } catch {
      // ignore
    }

    return () => {
      if (ws) ws.close();
    };
  }, []);

  // Switch target (Discord <-> Desktop <-> Virtual Output)
  const handleSwitchTarget = async (newTarget: PlaybackTarget) => {
    setIsLoading(true);
    setFallbackMessage(null);
    try {
      const res = await fetch('/api/audio/target', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: newTarget }),
      });
      if (res.ok) {
        setTarget(newTarget);
        if (window.gakkiDesktop?.audio?.switchTarget) {
          await window.gakkiDesktop.audio.switchTarget(newTarget);
        }
        onRefresh?.();
      }
    } catch {
      // ignore
    } finally {
      setIsLoading(false);
    }
  };

  // Change Output Device
  const handleOutputChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newId = e.target.value;
    setActiveOutputId(newId);
    setFallbackMessage(null);
    try {
      const res = await fetch('/api/audio/device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: newId, type: 'output' }),
      });
      if (res.ok) {
        if (window.gakkiDesktop?.audio?.setOutputDevice) {
          await window.gakkiDesktop.audio.setOutputDevice(newId);
        }
      }
    } catch {
      // ignore
    }
  };

  // Change Input Device
  const handleInputChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newId = e.target.value;
    setActiveInputId(newId);
    try {
      const res = await fetch('/api/audio/device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: newId, type: 'input' }),
      });
      if (res.ok) {
        if (window.gakkiDesktop?.audio?.setInputDevice) {
          await window.gakkiDesktop.audio.setInputDevice(newId);
        }
      }
    } catch {
      // ignore
    }
  };

  // Toggle Monitoring
  const handleToggleMonitoring = async () => {
    const nextState = !monitoringEnabled;
    setMonitoringEnabled(nextState);
    try {
      const res = await fetch('/api/audio/monitor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: nextState,
          monitorDeviceId: monitorDeviceId || activeOutputId,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        setFallbackMessage(err.error || 'Failed to update monitoring');
        setMonitoringEnabled(!nextState); // rollback
      }
    } catch {
      setMonitoringEnabled(!nextState);
    }
  };

  // Check virtual driver presence
  const virtualDevices = outputDevices.filter((d) => d.isVirtual || d.name.toLowerCase().includes('cable') || d.name.toLowerCase().includes('virtual') || d.name.toLowerCase().includes('voicemeeter'));
  const hasVirtualDevice = virtualDevices.length > 0;

  return (
    <div className="audio-routing-container">
      {/* Header */}
      <div className="section-header-row">
        <div>
          <h2 className="section-title">⚙️ Audio Routing & Desktop Settings</h2>
          <p className="section-subtitle">
            Configure platform-independent audio outputs, physical speakers/headphones, and virtual audio loopbacks.
          </p>
        </div>
        <div className="routing-header-actions">
          <span className={`device-spec-pill ${isDesktop ? 'desktop-active' : ''}`}>
            {isDesktop ? '🖥️ Desktop App Mode' : '🌐 Browser Mode'}
          </span>
          <button
            className="secondary-btn"
            onClick={fetchAudioState}
            disabled={isLoading}
            title="Rescan connected audio devices"
          >
            🔄 Refresh Devices
          </button>
        </div>
      </div>

      {fallbackMessage && (
        <div className="alert-banner warning">
          <span className="alert-icon">⚠️</span>
          <span className="alert-text">{fallbackMessage}</span>
          <button className="banner-close-btn" onClick={() => setFallbackMessage(null)}>✕</button>
        </div>
      )}

      {/* 1. PLAYBACK TARGET SELECTOR (Requirement 14) */}
      <div className="settings-card glass-card">
        <h3 className="card-title">🎯 Playback Target</h3>
        <p className="card-desc">
          Route Gakki's audio engine independently. Switching target seamlessly retains current track, queue, volume, and DJ state.
        </p>

        <div className="target-cards-grid">
          {/* Target 1: Discord */}
          <div
            className={`target-card ${target === 'discord' ? 'active' : ''}`}
            onClick={() => handleSwitchTarget('discord')}
          >
            <div className="target-header">
              <span className="target-radio">{target === 'discord' ? '●' : '○'}</span>
              <span className="target-icon">🤖</span>
              <h4 className="target-name">Discord Bot</h4>
            </div>
            <p className="target-description">
              Stream music directly into Discord voice channels via the Gakki bot.
            </p>
            <div className="target-badges">
              <span className="badge">Opus 48kHz</span>
              <span className="badge">Multi-Guild</span>
            </div>
          </div>

          {/* Target 2: Desktop */}
          <div
            className={`target-card ${target === 'desktop' ? 'active' : ''}`}
            onClick={() => handleSwitchTarget('desktop')}
          >
            <div className="target-header">
              <span className="target-radio">{target === 'desktop' ? '●' : '○'}</span>
              <span className="target-icon">🔊</span>
              <h4 className="target-name">Desktop Audio</h4>
            </div>
            <p className="target-description">
              Output directly to your local PC speakers, headphones, or USB DAC without Discord.
            </p>
            <div className="target-badges">
              <span className="badge badge-accent">Lossless PCM</span>
              <span className="badge">Hotplug Resilient</span>
            </div>
          </div>

          {/* Target 3: Virtual Output */}
          <div
            className={`target-card ${target === 'virtual' ? 'active' : ''}`}
            onClick={() => handleSwitchTarget('virtual')}
          >
            <div className="target-header">
              <span className="target-radio">{target === 'virtual' ? '●' : '○'}</span>
              <span className="target-icon">🔀</span>
              <h4 className="target-name">Virtual Output</h4>
            </div>
            <p className="target-description">
              Route audio into a virtual loopback cable (VB-Audio / VoiceMeeter) to send into Meet or Discord.
            </p>
            <div className="target-badges">
              <span className={`badge ${hasVirtualDevice ? 'badge-success' : 'badge-warning'}`}>
                {hasVirtualDevice ? '✓ Driver Detected' : 'Manual Setup'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* 2. DEVICE MANAGEMENT (Requirement 8) */}
      <div className="settings-grid-two-col">
        {/* Output Device */}
        <div className="settings-card glass-card">
          <div className="card-header-with-badge">
            <h3 className="card-title">🔊 Output Device</h3>
            <span className="device-spec-pill">48 kHz • Stereo Float</span>
          </div>
          <p className="card-desc">
            Select the physical or virtual device where Gakki outputs sound.
          </p>

          <div className="form-group">
            <label className="form-label" htmlFor="output-device-select">
              OUTPUT DEVICE
            </label>
            <select
              id="output-device-select"
              className="settings-select"
              value={activeOutputId}
              onChange={handleOutputChange}
            >
              {outputDevices.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name} {device.isDefault ? '(System Default)' : ''} {device.isVirtual ? '🔀 [Virtual]' : ''}
                </option>
              ))}
            </select>
          </div>

          <div className="device-meta-footer">
            <span className="device-meta-item">
              <strong>Format:</strong> 48,000 Hz, 2 Channels
            </span>
            <span className="device-meta-item">
              <strong>Fallback:</strong> System Default (Auto-recovering)
            </span>
          </div>
        </div>

        {/* Input Device (Requirement 7) */}
        <div className="settings-card glass-card">
          <div className="card-header-with-badge">
            <h3 className="card-title">🎙️ Input Device</h3>
            <span className="device-spec-pill">16-bit PCM • Capture</span>
          </div>
          <p className="card-desc">
            Prepared capture device for voice recordings and platform routing.
          </p>

          <div className="form-group">
            <label className="form-label" htmlFor="input-device-select">
              INPUT DEVICE
            </label>
            <select
              id="input-device-select"
              className="settings-select"
              value={activeInputId}
              onChange={handleInputChange}
            >
              {inputDevices.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name} {device.isDefault ? '(Default Mic)' : ''}
                </option>
              ))}
            </select>
          </div>

          <div className="device-meta-footer">
            <span className="device-meta-item">
              <strong>Mode:</strong> Monitored Input Pipeline
            </span>
            <span className="device-meta-item">
              <strong>Isolation:</strong> Server Authoritative
            </span>
          </div>
        </div>
      </div>

      {/* 3. LOOPBACK / MONITORING (Requirement 12) */}
      <div className="settings-card glass-card">
        <div className="monitoring-header-row">
          <div>
            <h3 className="card-title">🎧 Loopback & Monitoring</h3>
            <p className="card-desc">
              Listen to the processed audio output in your headphones with strict anti-feedback loop protection.
            </p>
          </div>
          <div className="monitoring-toggle-group">
            <span className="toggle-label">MONITOR OUTPUT:</span>
            <button
              className={`toggle-switch-btn ${monitoringEnabled ? 'active' : ''}`}
              onClick={handleToggleMonitoring}
              aria-pressed={monitoringEnabled}
            >
              {monitoringEnabled ? 'ON' : 'OFF'}
            </button>
          </div>
        </div>

        {monitoringEnabled && (
          <div className="monitoring-details-panel">
            <div className="form-group">
              <label className="form-label" htmlFor="monitor-device-select">
                MONITOR DEVICE
              </label>
              <select
                id="monitor-device-select"
                className="settings-select"
                value={monitorDeviceId || activeOutputId}
                onChange={(e) => setMonitorDeviceId(e.target.value)}
              >
                {outputDevices.map((device) => (
                  <option key={device.id} value={device.id}>
                    {device.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="anti-feedback-notice">
              <span className="notice-icon">🛡️</span>
              <span>
                <strong>Anti-Feedback Protection Active:</strong> Microphone input is strictly isolated from monitor routing to prevent dangerous acoustic loops.
              </span>
            </div>
          </div>
        )}
      </div>

      {/* 4. VIRTUAL AUDIO CONFIGURATION (Requirement 10 & 11) */}
      <div className="settings-card glass-card">
        <div className="virtual-driver-status-row">
          <div className="virtual-status-left">
            <span className="virtual-status-icon">{hasVirtualDevice ? '✅' : 'ℹ️'}</span>
            <div>
              <h4 className="card-title">Virtual Audio Device Integration</h4>
              <p className="card-desc">
                {hasVirtualDevice
                  ? `Virtual Audio Cable detected (${virtualDevices[0].name}). Gakki can route audio to meeting apps without Discord bot.`
                  : 'No virtual audio cable detected yet. Configure a loopback driver to send Gakki directly into Discord or Google Meet.'}
              </p>
            </div>
          </div>
          <button
            className="secondary-btn"
            onClick={() => setShowSetupGuide(!showSetupGuide)}
          >
            {showSetupGuide ? 'Hide Setup Guide' : '📖 Manual Setup Guide'}
          </button>
        </div>

        {showSetupGuide && (
          <div className="setup-guide-box">
            <h5 className="guide-title">How to Configure Virtual Audio Routing</h5>
            <ol className="guide-steps">
              <li>
                <strong>Download Driver:</strong> Install a reputable free driver such as{' '}
                <a href="https://vb-audio.com/Cable/" target="_blank" rel="noreferrer" className="guide-link">
                  VB-Audio Virtual Cable
                </a>{' '}
                or VoiceMeeter on Windows (or BlackHole on macOS).
              </li>
              <li>
                <strong>Refresh Gakki Devices:</strong> Click "Refresh Devices" above. Your new virtual cable will appear in the Output Device list.
              </li>
              <li>
                <strong>Select Output:</strong> Choose <code>CABLE Input (VB-Audio Virtual Cable)</code> as Gakki's output device.
              </li>
              <li>
                <strong>Set Application Input:</strong> In Discord, Google Meet, Zoom, or OBS, set your Microphone to{' '}
                <code>CABLE Output (VB-Audio Virtual Cable)</code>.
              </li>
              <li>
                <strong>Done:</strong> Gakki now streams pristine 48kHz audio directly into your voice call without requiring any bot permissions!
              </li>
            </ol>
          </div>
        )}
      </div>

      {/* 5. DESKTOP PREFERENCES & HOTKEYS (Requirements 20, 21, 22, 31) */}
      <div className="settings-card glass-card">
        <h3 className="card-title">🖥️ Desktop App & System Integration</h3>
        <p className="card-desc">
          Native integration for background playback, hotkeys, and system tray.
        </p>

        <div className="desktop-features-grid">
          {/* System Tray */}
          <div className="feature-item">
            <div className="feature-icon">📥</div>
            <div className="feature-info">
              <h5 className="feature-name">System Tray Mode</h5>
              <p className="feature-desc">
                Minimizes to tray on close instead of exiting. Playback continues uninterrupted in the background.
              </p>
            </div>
            <span className="feature-status-pill active">Active</span>
          </div>

          {/* Global Hotkeys */}
          <div className="feature-item">
            <div className="feature-icon">⌨️</div>
            <div className="feature-info">
              <h5 className="feature-name">Global Media Hotkeys</h5>
              <p className="feature-desc">
                Controls playback from any app: Media Keys or Ctrl+Alt+Space (Play/Pause), Ctrl+Alt+Arrows (Skip/Seek).
              </p>
            </div>
            <span className="feature-status-pill active">Registered</span>
          </div>

          {/* Native Notifications */}
          <div className="feature-item">
            <div className="feature-icon">🔔</div>
            <div className="feature-info">
              <h5 className="feature-name">Native Notifications</h5>
              <p className="feature-desc">
                Desktop alerts for track changes, playlist playback, and voice recording start/stop.
              </p>
            </div>
            <span className="feature-status-pill active">Enabled</span>
          </div>

          {/* Diagnostic Logs */}
          <div className="feature-item">
            <div className="feature-icon">📄</div>
            <div className="feature-info">
              <h5 className="feature-name">User Diagnostic Logs</h5>
              <p className="feature-desc">
                Sanitized logs stored locally. No credentials or secrets ever recorded.
                {logPath && <code className="log-path-preview">{logPath}</code>}
              </p>
            </div>
            <button
              className="secondary-btn small-btn"
              onClick={() => {
                if (window.gakkiDesktop?.logs?.openLogDirectory) {
                  window.gakkiDesktop.logs.openLogDirectory();
                } else {
                  alert(`Logs are stored at: ${logPath || '%APPDATA%\\Gakki\\logs\\desktop.log'}`);
                }
              }}
            >
              Open Log Directory
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
