import React, { useState, useEffect, useRef } from 'react';

interface VoiceState {
  enabled: boolean;
  status: 'OFF' | 'IDLE_LISTENING' | 'WAKE_WORD_DETECTED' | 'PROCESSING_COMMAND' | 'SPEAKING_RESPONSE' | 'ERROR';
  activeInputDevice: string | null;
  isVadActive: boolean;
  lastWakeWordAt: string | null;
  lastCommandAt: string | null;
  lastIntent: string | null;
  geminiLiveConnected: boolean;
  isBargeInActive: boolean;
  vadSensitivity: number;
  wakeWord: string;
}

interface DJConfig {
  enabled: boolean;
  cooldownSeconds: number;
  mixingMode: 'BETWEEN_SONGS' | 'DUCKED_VOICE_OVER_MUSIC';
  duckingVolumeMultiplier: number;
  voiceProfile: string;
}

interface MeetStatus {
  configured: boolean;
  eligibility?: {
    isConfigured: boolean;
    isAuthenticated: boolean;
    developerPreviewEnrolled: boolean;
    scopes: string[];
    statusMessage: string;
  };
  state?: {
    voiceState: string;
    playerState: string;
  };
  capabilities?: {
    receiveAudio: boolean;
    receiveVideo: boolean;
    participantMetadata: boolean;
    sendAudio: boolean;
    recording: boolean;
  };
  virtualAudioWorkaround?: {
    supported: boolean;
    method: string;
    instructions: string;
  };
}

interface MeetParticipant {
  platformParticipantId: string;
  displayName?: string;
  isAnonymous?: boolean;
  isPhone?: boolean;
  joinedAt?: string;
}

interface ChatMessage {
  id: string;
  sender: 'user' | 'gakki';
  timestamp: string;
  text: string;
  intent?: string;
  success?: boolean;
  latencyMs?: number;
  provider?: string;
  candidates?: string[];
}

export const VoiceCommandSection: React.FC = () => {
  const [voiceState, setVoiceState] = useState<VoiceState>({
    enabled: false,
    status: 'OFF',
    activeInputDevice: 'Default Microphone',
    isVadActive: false,
    lastWakeWordAt: null,
    lastCommandAt: null,
    lastIntent: null,
    geminiLiveConnected: false,
    isBargeInActive: true,
    vadSensitivity: 0.025,
    wakeWord: 'Hey Gakki',
  });

  const [djConfig, setDjConfig] = useState<DJConfig>({
    enabled: true,
    cooldownSeconds: 180,
    mixingMode: 'BETWEEN_SONGS',
    duckingVolumeMultiplier: 0.25,
    voiceProfile: 'Puck',
  });

  const [meetStatus, setMeetStatus] = useState<MeetStatus | null>(null);
  const [meetParticipants, setMeetParticipants] = useState<MeetParticipant[]>([]);
  const [meetSpaceId, setMeetSpaceId] = useState<string>('abc-defg-hij');

  const [commandInput, setCommandInput] = useState<string>('Hey Gakki, play After Dark');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome-msg',
      sender: 'gakki',
      timestamp: new Date().toLocaleTimeString(),
      text: 'Hello! I am Gakki, your AI Music & Voice Agent. Say "Hey Gakki" or use the control panel below to command music playback, adjust volume, or ask questions.',
      intent: 'READY',
      provider: 'gemini_live',
    },
  ]);
  const [isProcessingCommand, setIsProcessingCommand] = useState<boolean>(false);
  const [isGeneratingDJPreview, setIsGeneratingDJPreview] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<'commands' | 'dj' | 'meet'>('commands');
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);

  const scrollToBottom = () => {
    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }, 60);
  };

  useEffect(() => {
    scrollToBottom();
  }, [chatMessages.length, isProcessingCommand]);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 4000);
  };

  const fetchVoiceState = async () => {
    try {
      const res = await fetch('/api/voice/state');
      if (res.ok) {
        const data = await res.json();
        if (data.state) setVoiceState(data.state);
      }
    } catch {
      // offline fallback
    }
  };

  const fetchDJConfig = async () => {
    try {
      const res = await fetch('/api/voice/dj-commentary');
      if (res.ok) {
        const data = await res.json();
        if (data.config) setDjConfig(data.config);
      }
    } catch {
      // offline fallback
    }
  };

  const fetchMeetStatus = async () => {
    try {
      const res = await fetch('/api/meet/status');
      if (res.ok) {
        const data = await res.json();
        setMeetStatus(data);
      }
      const pRes = await fetch('/api/meet/participants');
      if (pRes.ok) {
        const pData = await pRes.json();
        if (pData.participants) setMeetParticipants(pData.participants);
      }
    } catch {
      // offline fallback
    }
  };

  useEffect(() => {
    fetchVoiceState();
    fetchDJConfig();
    fetchMeetStatus();
    const interval = setInterval(() => {
      fetchVoiceState();
    }, 4000);
    return () => clearInterval(interval);
  }, []);

  const handleToggleVoice = async () => {
    const nextEnabled = !voiceState.enabled;
    try {
      const res = await fetch('/api/voice/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: nextEnabled }),
      });
      if (res.ok) {
        const data = await res.json();
        setVoiceState(data.state);
        showToast(nextEnabled ? '🎤 Voice Commands Enabled (Listening)' : '🔇 Voice Commands Disabled (Privacy Active)');
      }
    } catch (err: any) {
      showToast(`Error updating voice state: ${err.message}`);
    }
  };

  const handleExecuteCommand = async (customTranscript?: string) => {
    const text = customTranscript || commandInput;
    if (!text.trim()) return;

    const userMsg: ChatMessage = {
      id: String(Date.now()),
      sender: 'user',
      timestamp: new Date().toLocaleTimeString(),
      text: text,
    };

    setChatMessages((prev) => [...prev, userMsg]);
    if (!customTranscript) {
      setCommandInput('');
    }

    setIsProcessingCommand(true);
    try {
      const res = await fetch('/api/voice/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: text }),
      });

      if (res.ok) {
        const data = await res.json();
        const gakkiMsg: ChatMessage = {
          id: String(Date.now() + 1),
          sender: 'gakki',
          timestamp: new Date().toLocaleTimeString(),
          text: data.result?.message || 'Command executed successfully.',
          intent: data.result?.intent,
          success: data.result?.success ?? true,
          latencyMs: data.result?.latencyMs || 45,
          provider: data.result?.provider || 'local_deterministic',
          candidates: data.result?.candidates,
        };
        setChatMessages((prev) => [...prev, gakkiMsg]);
        showToast(`Executed: ${data.result?.message || data.result?.intent || 'Success'}`);
      } else {
        const err = await res.json();
        const errMsg: ChatMessage = {
          id: String(Date.now() + 1),
          sender: 'gakki',
          timestamp: new Date().toLocaleTimeString(),
          text: `⚠️ Error: ${err.error || 'Failed to process command.'}`,
          success: false,
          intent: 'ERROR',
        };
        setChatMessages((prev) => [...prev, errMsg]);
        showToast(`Command error: ${err.error || 'Failed'}`);
      }
    } catch (err: any) {
      const errMsg: ChatMessage = {
        id: String(Date.now() + 1),
        sender: 'gakki',
        timestamp: new Date().toLocaleTimeString(),
        text: `⚠️ Network error: ${err.message}`,
        success: false,
        intent: 'NETWORK_ERROR',
      };
      setChatMessages((prev) => [...prev, errMsg]);
      showToast(`Error executing command: ${err.message}`);
    } finally {
      setIsProcessingCommand(false);
    }
  };

  const handleUpdateDJConfig = async (updates: Partial<DJConfig>) => {
    const next = { ...djConfig, ...updates };
    setDjConfig(next);
    try {
      await fetch('/api/voice/dj-commentary/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      showToast('AI DJ Commentary settings updated');
    } catch {
      // ignore
    }
  };

  const handlePreviewDJ = async () => {
    setIsGeneratingDJPreview(true);
    try {
      const res = await fetch('/api/voice/dj-commentary/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trigger: 'DJ_START' }),
      });
      if (res.ok) {
        const data = await res.json();
        showToast(`🎙️ DJ Commentary: "${data.commentary?.text || 'Generated sample'}"`);
      }
    } catch (err: any) {
      showToast(`DJ preview error: ${err.message}`);
    } finally {
      setIsGeneratingDJPreview(false);
    }
  };

  const handleConnectMeet = async () => {
    if (!meetSpaceId) return;
    try {
      const res = await fetch('/api/meet/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spaceId: meetSpaceId }),
      });
      if (res.ok) {
        showToast(`Connected to Google Meet space ${meetSpaceId}`);
        fetchMeetStatus();
      } else {
        const err = await res.json();
        showToast(`Meet error: ${err.error}`);
      }
    } catch (err: any) {
      showToast(`Meet connect error: ${err.message}`);
    }
  };

  const handleDisconnectMeet = async () => {
    try {
      await fetch('/api/meet/disconnect', { method: 'POST' });
      showToast('Disconnected from Google Meet');
      fetchMeetStatus();
    } catch (err: any) {
      showToast(`Meet disconnect error: ${err.message}`);
    }
  };

  const handleStartMeetRecording = async () => {
    try {
      const res = await fetch('/api/meet/record/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startedBy: 'user_web', title: `Meet Recording - ${meetSpaceId}` }),
      });
      if (res.ok) {
        const data = await res.json();
        showToast(`🎙️ Linked conference audio to Recording ID: ${data.recordingId}`);
      } else {
        const err = await res.json();
        showToast(`Recording link error: ${err.error}`);
      }
    } catch (err: any) {
      showToast(`Error starting recording: ${err.message}`);
    }
  };

  return (
    <div className="voice-commands-container">
      {toastMessage && <div className="floating-toast">{toastMessage}</div>}

      {/* Header & Master Toggle */}
      <div className="voice-header-card">
        <div className="voice-header-info">
          <h2>🎤 Voice Commands, Gemini Agent & Google Meet</h2>
          <p className="voice-subtitle">
            Local wake-word detection, Gemini Live bidirectional agent, AI DJ voice commentary & receive-only Meet conference adapter.
          </p>
        </div>
        <div className="voice-master-toggle-box">
          <div className={`status-pill ${voiceState.enabled ? 'active' : 'inactive'}`}>
            {voiceState.enabled ? '● VOICE ACTIVE' : '○ VOICE MUTED'}
          </div>
          <button
            className={`btn-master-toggle ${voiceState.enabled ? 'enabled' : 'disabled'}`}
            onClick={handleToggleVoice}
          >
            {voiceState.enabled ? 'Turn OFF Voice' : 'Turn ON Voice'}
          </button>
        </div>
      </div>

      {/* Navigation Subtabs */}
      <div className="voice-nav-tabs">
        <button
          className={`voice-tab-btn ${activeTab === 'commands' ? 'active' : ''}`}
          onClick={() => setActiveTab('commands')}
        >
          🎙️ Voice Commands & Gemini
        </button>
        <button
          className={`voice-tab-btn ${activeTab === 'dj' ? 'active' : ''}`}
          onClick={() => setActiveTab('dj')}
        >
          🎧 AI DJ Voice Commentary
        </button>
        <button
          className={`voice-tab-btn ${activeTab === 'meet' ? 'active' : ''}`}
          onClick={() => setActiveTab('meet')}
        >
          📹 Google Meet Adapter
        </button>
      </div>

      {/* TAB 1: VOICE COMMANDS */}
      {activeTab === 'commands' && (
        <div className="voice-chat-stage">
            {/* Top Pipeline Status Strip */}
            <div className="voice-pipeline-strip">
              <div className="strip-item">
                <span className="strip-label">Wake Word</span>
                <span className="strip-value highlight">"{voiceState.wakeWord}" (Local)</span>
              </div>
              <div className="strip-item">
                <span className="strip-label">VAD Activity</span>
                <span className={`strip-value ${voiceState.isVadActive ? 'active' : ''}`}>
                  {voiceState.isVadActive ? '🗣️ Speech Detected' : '🤫 Silence'}
                </span>
              </div>
              <div className="strip-item">
                <span className="strip-label">Gemini Live</span>
                <span className={`strip-value ${voiceState.geminiLiveConnected ? 'active' : ''}`}>
                  {voiceState.geminiLiveConnected ? '⚡ Connected (24kHz)' : '🔒 Local Matcher'}
                </span>
              </div>
              <div className="strip-item">
                <span className="strip-label">Barge-in</span>
                <span className="strip-value">{voiceState.isBargeInActive ? '✅ Active' : '⏸️ AI Speaking'}</span>
              </div>
              <div className="strip-item">
                <span className="strip-label">Input Format</span>
                <span className="strip-value">16 kHz PCM</span>
              </div>
            </div>

            {/* Conversational Chat Container with Sticky Bottom Control Panel */}
            <div className="voice-chat-container">
              {/* Scrollable Chat Stream */}
              <div className="voice-chat-messages" ref={chatScrollRef}>
                <div className="chat-intro-card">
                  <div className="chat-intro-avatar">🤖</div>
                  <div className="chat-intro-content">
                    <h4>Gakki Voice Agent & Gemini Live</h4>
                    <p>
                      Speak <code className="wake-code">"Hey Gakki"</code> followed by your command, or use the
                      control panel docked at the bottom to send natural voice commands.
                    </p>
                    <div className="privacy-pill">
                      🛡️ Local wake-word evaluation • Zero persistent audio recording • Backend permissions enforced
                    </div>
                  </div>
                </div>

                {chatMessages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`chat-bubble-wrapper ${msg.sender === 'user' ? 'user-msg' : 'gakki-msg'}`}
                  >
                    <div className="chat-bubble-avatar">
                      {msg.sender === 'user' ? '👤' : '🤖'}
                    </div>
                    <div className="chat-bubble-body">
                      <div className="chat-bubble-meta">
                        <span className="chat-bubble-sender">
                          {msg.sender === 'user' ? 'You' : 'Gakki Assistant'}
                        </span>
                        <span className="chat-bubble-time">{msg.timestamp}</span>
                        {msg.intent && <span className="chat-bubble-intent">{msg.intent}</span>}
                        {msg.provider && <span className="chat-bubble-provider">{msg.provider}</span>}
                        {msg.latencyMs != null && (
                          <span className="chat-bubble-latency">{msg.latencyMs}ms</span>
                        )}
                      </div>
                      <div className="chat-bubble-text">{msg.text}</div>

                      {/* Ambiguity Choices if returned */}
                      {msg.candidates && msg.candidates.length > 0 && (
                        <div className="chat-candidates-box">
                          <span className="candidates-title">Select an option:</span>
                          <div className="candidates-buttons">
                            {msg.candidates.map((cand, idx) => (
                              <button
                                key={idx}
                                className="candidate-choice-btn"
                                onClick={() => handleExecuteCommand(String(idx + 1))}
                              >
                                {idx + 1}. {cand}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                ))}

                {isProcessingCommand && (
                  <div className="chat-bubble-wrapper gakki-msg processing">
                    <div className="chat-bubble-avatar">🤖</div>
                    <div className="chat-bubble-body">
                      <div className="chat-bubble-text typing-indicator">
                        <span>●</span>
                        <span>●</span>
                        <span>●</span>
                        <em>Processing voice intent...</em>
                      </div>
                    </div>
                  </div>
                )}

                {/* ALWAYS-AT-BOTTOM CONTROL PANEL: Positioned right below the newest chats */}
                <div
                  key={`control-panel-${chatMessages.length}-${isProcessingCommand}`}
                  className="voice-chat-control-panel in-stream"
                >
                  {/* Quick Command Suggestions Chips */}
                  <div className="control-quick-chips">
                    <span className="chips-label">Quick Commands:</span>
                    <div className="chips-scroll">
                      <button
                        className="quick-chip"
                        onClick={() => handleExecuteCommand('Hey Gakki, play After Dark')}
                      >
                        ▶️ Play After Dark
                      </button>
                      <button
                        className="quick-chip"
                        onClick={() => handleExecuteCommand('Hey Gakki, pause')}
                      >
                        ⏸️ Pause
                      </button>
                      <button
                        className="quick-chip"
                        onClick={() => handleExecuteCommand('Hey Gakki, resume')}
                      >
                        ⏯️ Resume
                      </button>
                      <button
                        className="quick-chip"
                        onClick={() => handleExecuteCommand('Hey Gakki, skip')}
                      >
                        ⏭️ Skip
                      </button>
                      <button
                        className="quick-chip"
                        onClick={() => handleExecuteCommand('Hey Gakki, smart shuffle')}
                      >
                        🔀 Smart Shuffle
                      </button>
                      <button
                        className="quick-chip"
                        onClick={() => handleExecuteCommand('Hey Gakki, enable dj')}
                      >
                        🎧 Enable DJ
                      </button>
                      <button
                        className="quick-chip"
                        onClick={() => handleExecuteCommand('Hey Gakki, show lyrics')}
                      >
                        📜 Lyrics
                      </button>
                      <button
                        className="quick-chip"
                        onClick={() => handleExecuteCommand('Hey Gakki, what should I play next?')}
                      >
                        💬 What next?
                      </button>
                    </div>
                  </div>

                  {/* Main Input Control Bar */}
                  <div className="control-input-bar">
                    <button
                      className={`btn-mic-indicator ${voiceState.enabled ? 'listening' : 'muted'}`}
                      onClick={handleToggleVoice}
                      title={voiceState.enabled ? 'Mic is Active (Click to mute)' : 'Mic is Muted (Click to enable)'}
                    >
                      <span className="mic-icon">{voiceState.enabled ? '🎙️' : '🔇'}</span>
                      <span className="mic-pulse" />
                    </button>

                    <input
                      type="text"
                      className="control-text-input"
                      value={commandInput}
                      onChange={(e) => setCommandInput(e.target.value)}
                      placeholder="Type or speak a command (e.g. 'Hey Gakki, play After Dark')..."
                      onKeyDown={(e) => e.key === 'Enter' && handleExecuteCommand()}
                    />

                    {chatMessages.length > 0 && (
                      <button
                        className="btn-clear-chat"
                        onClick={() => setChatMessages([])}
                        title="Clear chat history"
                      >
                        🗑️
                      </button>
                    )}

                    <button
                      className="btn-send-voice"
                      disabled={isProcessingCommand || !commandInput.trim()}
                      onClick={() => handleExecuteCommand()}
                    >
                      {isProcessingCommand ? (
                        <span className="sending-spinner">⏳ Sending...</span>
                      ) : (
                        <span>Send Command ↵</span>
                      )}
                    </button>
                  </div>

                  {/* Footer status / shortcuts helper */}
                  <div className="control-panel-footer">
                    <span className="shortcut-hint">
                      💡 Tip: Say <strong>"Hey Gakki"</strong> or press <strong>Enter ↵</strong> to dispatch
                    </span>
                    <span className="latency-hint">
                      Last Intent: <strong className="highlight">{voiceState.lastIntent || 'None'}</strong>
                    </span>
                  </div>
                </div>

                <div ref={messagesEndRef} style={{ height: '1px', minHeight: '1px' }} />
              </div>
            </div>
          </div>
        )}

      {/* TAB 2: AI DJ COMMENTARY */}
      {activeTab === 'dj' && (
        <div className="tab-content-grid">
          <div className="voice-card">
            <h3>AI DJ Commentary Settings</h3>
            <div className="config-form">
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={djConfig.enabled}
                  onChange={(e) => handleUpdateDJConfig({ enabled: e.target.checked })}
                />
                Enable AI DJ Voice Commentary
              </label>

              <div className="form-group">
                <label>Commentary Cooldown ({djConfig.cooldownSeconds}s)</label>
                <input
                  type="range"
                  min="30"
                  max="600"
                  step="30"
                  value={djConfig.cooldownSeconds}
                  onChange={(e) => handleUpdateDJConfig({ cooldownSeconds: parseInt(e.target.value, 10) })}
                />
                <span className="hint-text">Minimum time gap between automatic DJ speech triggers.</span>
              </div>

              <div className="form-group">
                <label>Commentary Mixing Mode</label>
                <select
                  value={djConfig.mixingMode}
                  onChange={(e) => handleUpdateDJConfig({ mixingMode: e.target.value as any })}
                >
                  <option value="BETWEEN_SONGS">Between Songs (Played during crossfade gap)</option>
                  <option value="DUCKED_VOICE_OVER_MUSIC">Ducked Voice-over-Music (Lowers music by -12dB)</option>
                </select>
              </div>

              <div className="form-group">
                <label>TTS Voice Persona</label>
                <select
                  value={djConfig.voiceProfile}
                  onChange={(e) => handleUpdateDJConfig({ voiceProfile: e.target.value })}
                >
                  <option value="Puck">Puck (Energetic, Youthful Radio DJ)</option>
                  <option value="Aoede">Aoede (Expressive, Warm Female Host)</option>
                  <option value="Charon">Charon (Deep, Smooth Broadcaster)</option>
                  <option value="Kore">Kore (Bright, Friendly Presenter)</option>
                  <option value="Fenrir">Fenrir (Smooth Announcer)</option>
                  <option value="Gakki-Local-Default">Gakki Local (Offline Fallback Synthesizer)</option>
                </select>
              </div>

              <button
                className="btn-preview-dj"
                disabled={isGeneratingDJPreview}
                onClick={handlePreviewDJ}
              >
                {isGeneratingDJPreview ? 'Generating TTS...' : '🎙️ Generate Commentary Preview'}
              </button>
            </div>
          </div>

          <div className="voice-card">
            <h3>Pre-Generation & Priority Rules</h3>
            <div className="rule-box">
              <h4>⚡ Zero Audio Gap Guarantee (Requirement 18)</h4>
              <p>
                Commentary text and TTS audio buffers are pre-rendered asynchronously before the track transition occurs. The music engine never waits or introduces silence gaps for AI generation.
              </p>
            </div>
            <div className="rule-box">
              <h4>⚖️ Strict Execution Hierarchy (Requirement 20)</h4>
              <ol>
                <li><strong>User Speech / Command:</strong> Highest priority (immediately ducks/mutes DJ).</li>
                <li><strong>Music Playback Continuity:</strong> Buffer underruns are never permitted.</li>
                <li><strong>System / Alarm Audio:</strong> Errors and connection alerts.</li>
                <li><strong>DJ Commentary:</strong> Lowest priority; automatically skipped if system is busy.</li>
              </ol>
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: GOOGLE MEET ADAPTER */}
      {activeTab === 'meet' && (
        <div className="tab-content-grid">
          <div className="voice-card">
            <h3>Google Meet Media Adapter (Receive Path)</h3>
            <div className="meet-status-badge">
              <span className={`status-dot ${meetStatus?.state?.voiceState === 'CONNECTED' ? 'connected' : 'disconnected'}`} />
              <span>Status: {meetStatus?.state?.voiceState || 'DISCONNECTED'}</span>
            </div>

            <div className="developer-preview-banner">
              ⚠️ <strong>Google Meet Media API Constraint:</strong>
              <p>
                Official Meet Media API is currently Developer Preview and receive-only. Native media SEND into a conference is unsupported. Gakki consumes incoming audio/participants and routes outgoing music via the Desktop Virtual Audio Cable.
              </p>
            </div>

            <div className="meet-connect-form">
              <label>Meet Space ID or URL:</label>
              <div className="meet-input-row">
                <input
                  type="text"
                  value={meetSpaceId}
                  onChange={(e) => setMeetSpaceId(e.target.value)}
                  placeholder="abc-defg-hij"
                />
                {meetStatus?.state?.voiceState === 'CONNECTED' ? (
                  <button className="btn-disconnect" onClick={handleDisconnectMeet}>
                    Leave Meeting
                  </button>
                ) : (
                  <button className="btn-connect" onClick={handleConnectMeet}>
                    Join Conference (Receive)
                  </button>
                )}
              </div>
            </div>

            {meetStatus?.state?.voiceState === 'CONNECTED' && (
              <div className="meet-recording-action">
                <button className="btn-record-meet" onClick={handleStartMeetRecording}>
                  🎙️ Feed Conference Audio into Recording Service
                </button>
              </div>
            )}
          </div>

          <div className="voice-card">
            <h3>Desktop Virtual Audio Routing (Output Path)</h3>
            <div className="routing-guide-box">
              <h4>How to send Gakki Music into Google Meet:</h4>
              <ol>
                <li>In Gakki Audio Settings, set Playback Target to <strong>Virtual Audio Output</strong>.</li>
                <li>In Google Meet Settings &rarr; Audio &rarr; Microphone, select <strong>CABLE Output (VB-Audio Virtual Cable)</strong>.</li>
                <li>Participants in the Google Meet conference will hear Gakki's studio-grade music playback directly through your virtual mic!</li>
              </ol>
            </div>

            <div className="capabilities-summary">
              <h4>Meet Adapter Capabilities:</h4>
              <ul>
                <li>Receive Audio: <span className="cap-true">SUPPORTED (Official Media API)</span></li>
                <li>Participant Metadata: <span className="cap-true">SUPPORTED (Official API)</span></li>
                <li>Native Send Audio: <span className="cap-false">UNSUPPORTED (Developer Preview limitation)</span></li>
                <li>Send via Desktop Virtual Audio: <span className="cap-true">AVAILABLE (User-configured)</span></li>
              </ul>
            </div>
          </div>

          <div className="voice-card full-width">
            <h3>Active Conference Participants</h3>
            {meetParticipants.length === 0 ? (
              <p className="empty-text">No active participants detected. Join a Google Meet space to view participants.</p>
            ) : (
              <div className="participant-chips">
                {meetParticipants.map((p) => (
                  <div key={p.platformParticipantId} className="participant-chip">
                    <span className="p-avatar">👤</span>
                    <div className="p-info">
                      <span className="p-name">{p.displayName || 'Google Meet Participant'}</span>
                      {p.isAnonymous && <span className="badge-anon">Anonymous</span>}
                      {p.isPhone && <span className="badge-phone">Phone</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
