import React, { useState, useEffect, useRef } from 'react';

export interface Participant {
  id: string;
  userId: string;
  displayName: string;
  joinedAt: string;
  leftAt?: string | null;
  firstAudioTimestamp?: number;
  lastAudioTimestamp?: number;
  audioStorageKey?: string | null;
}

export interface TranscriptSegment {
  id: string;
  startMs: number;
  endMs: number;
  speakerId?: string | null;
  speakerName?: string;
  text: string;
  confidence?: number;
  position: number;
}

export interface RecordingTranscript {
  id: string;
  recordingId: string;
  provider: string;
  model?: string;
  language?: string;
  text?: string;
  status: string;
  segments?: TranscriptSegment[];
}

export interface RecordingSession {
  id: string;
  guildId: string;
  voiceChannelId: string;
  startedBy: string;
  startedAt: string;
  endedAt?: string | null;
  duration?: number | null;
  status: 'PENDING' | 'RECORDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'DELETED';
  storageKey?: string | null;
  format?: string;
  fileSizeBytes?: number | null;
  transcriptionStatus: 'NONE' | 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  visibility: 'PRIVATE' | 'GUILD';
  title?: string;
  participants?: Participant[];
  transcript?: RecordingTranscript | null;
}

interface RecordingsSectionProps {
  guildId: string;
}

export const RecordingsSection: React.FC<RecordingsSectionProps> = ({ guildId }) => {
  const [recordings, setRecordings] = useState<RecordingSession[]>([]);
  const [selectedRecording, setSelectedRecording] = useState<RecordingSession | null>(null);
  const [activeSession, setActiveSession] = useState<RecordingSession | null>(null);
  const [activeElapsed, setActiveElapsed] = useState<number>(0);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [transcriptSearch, setTranscriptSearch] = useState<string>('');
  const [speakerFilter, setSpeakerFilter] = useState<string>('ALL');
  const [showStartModal, setShowStartModal] = useState<boolean>(false);
  const [newTitle, setNewTitle] = useState<string>('');
  const [newVisibility, setNewVisibility] = useState<'GUILD' | 'PRIVATE'>('GUILD');

  // Audio Player State
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [playerDuration, setPlayerDuration] = useState<number>(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Poll recordings and active state
  const fetchRecordings = async () => {
    try {
      const res = await fetch(`/api/recordings?guildId=${guildId}`);
      if (res.ok) {
        const data = await res.json();
        setRecordings(data.recordings || []);
      }
    } catch (err) {
      console.error('Error fetching recordings:', err);
    }
  };

  const fetchActiveRecording = async () => {
    try {
      const res = await fetch(`/api/recordings/active/${guildId}`);
      if (res.ok) {
        const data = await res.json();
        setActiveSession(data.activeSession || null);
        if (data.activeSession && data.activeSession.duration) {
          setActiveElapsed(data.activeSession.duration);
        }
      }
    } catch {
      // Ignored
    }
  };

  useEffect(() => {
    setIsLoading(true);
    Promise.all([fetchRecordings(), fetchActiveRecording()]).finally(() => setIsLoading(false));

    const pollInterval = setInterval(() => {
      fetchRecordings();
      fetchActiveRecording();
    }, 4000);

    return () => clearInterval(pollInterval);
  }, [guildId]);

  // Live timer for active recording
  useEffect(() => {
    if (!activeSession || activeSession.status !== 'RECORDING') return;

    const timer = setInterval(() => {
      setActiveElapsed((prev) => prev + 1);
    }, 1000);

    return () => clearInterval(timer);
  }, [activeSession]);

  // Load single recording details when selected
  const handleSelectRecording = async (rec: RecordingSession) => {
    try {
      const res = await fetch(`/api/recordings/${rec.id}`);
      if (res.ok) {
        const data = await res.json();
        setSelectedRecording(data.recording);
        setCurrentTime(0);
        setIsPlaying(false);
      }
    } catch (err) {
      console.error('Error loading recording details:', err);
      setSelectedRecording(rec);
    }
  };

  // Start recording action
  const handleStartRecording = async () => {
    setShowStartModal(false);
    try {
      const res = await fetch(`/api/recordings/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          guildId,
          startedBy: 'Web Dashboard Operator',
          title: newTitle.trim() || undefined,
          visibility: newVisibility,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setActiveSession(data.session);
        setActiveElapsed(0);
        fetchRecordings();
      } else {
        const err = await res.json();
        alert(`Failed to start recording: ${err.error || 'Unknown error'}`);
      }
    } catch (err: any) {
      alert(`Error starting recording: ${err.message}`);
    }
  };

  // Stop recording action
  const handleStopRecording = async () => {
    if (!confirm('Are you sure you want to stop the recording session?')) return;
    try {
      const res = await fetch(`/api/recordings/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guildId, actorUserId: 'Web Dashboard Operator' }),
      });
      if (res.ok) {
        setActiveSession(null);
        await fetchRecordings();
      } else {
        const err = await res.json();
        alert(`Failed to stop recording: ${err.error || 'Unknown error'}`);
      }
    } catch (err: any) {
      alert(`Error stopping recording: ${err.message}`);
    }
  };

  // Delete recording action
  const handleDeleteRecording = async (id: string) => {
    if (!confirm('Permanently delete this recording, audio files, and transcripts? This cannot be undone.')) return;
    try {
      const res = await fetch(`/api/recordings/${id}`, {
        method: 'DELETE',
        headers: { 'x-user-id': 'Web Dashboard Operator' },
      });
      if (res.ok) {
        if (selectedRecording?.id === id) {
          setSelectedRecording(null);
        }
        await fetchRecordings();
      } else {
        const err = await res.json();
        alert(`Failed to delete recording: ${err.error}`);
      }
    } catch (err: any) {
      alert(`Error deleting recording: ${err.message}`);
    }
  };

  // Format seconds to mm:ss or hh:mm:ss
  const formatDuration = (secs: number = 0): string => {
    const s = Math.max(0, Math.floor(secs));
    const hours = Math.floor(s / 3600);
    const minutes = Math.floor((s % 3600) / 60);
    const seconds = s % 60;
    if (hours > 0) {
      return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  };

  // Format ms timestamp
  const formatMs = (ms: number = 0): string => {
    return formatDuration(ms / 1000);
  };

  // Filter recordings
  const filteredRecordings = recordings.filter((r) => {
    if (statusFilter !== 'ALL' && r.status !== statusFilter) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchTitle = (r.title || '').toLowerCase().includes(q);
      const matchParticipant = r.participants?.some((p) => p.displayName.toLowerCase().includes(q));
      if (!matchTitle && !matchParticipant) return false;
    }
    return true;
  });

  // Filter segments for selected recording
  const segments = selectedRecording?.transcript?.segments || [];
  const filteredSegments = segments.filter((seg) => {
    if (speakerFilter !== 'ALL' && (seg.speakerName || 'Unknown') !== speakerFilter) {
      return false;
    }
    if (transcriptSearch.trim()) {
      return seg.text.toLowerCase().includes(transcriptSearch.toLowerCase());
    }
    return true;
  });

  // Unique speakers
  const speakers = Array.from(new Set(segments.map((s) => s.speakerName || 'Unknown Speaker')));

  // Player controls
  const togglePlay = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.play().then(() => setIsPlaying(true)).catch(console.error);
    }
  };

  const handleSeek = (timeSec: number) => {
    if (!audioRef.current) return;
    audioRef.current.currentTime = timeSec;
    setCurrentTime(timeSec);
  };

  const handleCopyTranscript = () => {
    if (!selectedRecording?.transcript?.text) return;
    navigator.clipboard.writeText(selectedRecording.transcript.text);
    alert('Transcript copied to clipboard!');
  };

  return (
    <div className="recordings-section-container">
      {/* 1. Live Recording State Banner (Requirements 4, 6, 30) */}
      <div className={`recording-banner-card ${activeSession ? 'recording-active' : 'recording-idle'}`}>
        <div className="banner-left">
          <div className="status-indicator-badge">
            <span className={`pulse-dot ${activeSession ? 'pulse-red' : 'pulse-green'}`} />
            <span className="status-title-text">
              {activeSession ? '🔴 RECORDING IN PROGRESS' : '⚪ RECORDING ENGINE READY'}
            </span>
          </div>
          {activeSession ? (
            <div className="recording-live-stats">
              <span className="live-clock">{formatDuration(activeElapsed)}</span>
              <span className="live-meta">
                Channel: <strong>{activeSession.voiceChannelId}</strong>
              </span>
              <span className="live-meta">
                Session ID: <code>{activeSession.id.slice(0, 8)}</code>
              </span>
            </div>
          ) : (
            <p className="banner-subtext">
              Multi-participant voice capture with speaker alignment, WAV lossless mixing & local Whisper transcription.
            </p>
          )}
        </div>

        <div className="banner-right">
          {activeSession ? (
            <button className="btn-stop-recording" onClick={handleStopRecording} title="Finalize and mix audio">
              ⏹️ Stop Recording
            </button>
          ) : (
            <button
              className="btn-start-recording"
              onClick={() => setShowStartModal(true)}
              title="Start recording voice channel"
            >
              🎙️ Start Recording
            </button>
          )}
        </div>
      </div>

      {/* 2. Main Recording Workspace: List + Inspector */}
      <div className="recording-workspace-grid">
        {/* Left Column: Recording Sessions List */}
        <div className="recordings-list-panel">
          <div className="panel-header-controls">
            <h3>Recorded Sessions ({filteredRecordings.length})</h3>
            <div className="controls-row">
              <input
                type="text"
                className="recording-search-input"
                placeholder="Search title or speaker..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              <select
                className="recording-filter-select"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                <option value="ALL">All Statuses</option>
                <option value="COMPLETED">Completed</option>
                <option value="PROCESSING">Processing</option>
                <option value="RECORDING">Recording</option>
                <option value="FAILED">Failed</option>
              </select>
            </div>
          </div>

          <div className="recordings-scroll-list">
            {isLoading ? (
              <div className="empty-notice">Loading recordings...</div>
            ) : filteredRecordings.length === 0 ? (
              <div className="empty-notice">No voice recordings found.</div>
            ) : (
              filteredRecordings.map((rec) => {
                const isSelected = selectedRecording?.id === rec.id;
                const dateStr = new Date(rec.startedAt).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                });
                return (
                  <div
                    key={rec.id}
                    className={`recording-card-item ${isSelected ? 'selected' : ''}`}
                    onClick={() => handleSelectRecording(rec)}
                  >
                    <div className="item-header">
                      <h4 className="item-title">{rec.title || 'Voice Session'}</h4>
                      <span className={`status-pill pill-${rec.status.toLowerCase()}`}>{rec.status}</span>
                    </div>

                    <div className="item-metadata-row">
                      <span>📅 {dateStr}</span>
                      <span>⏱️ {formatDuration(rec.duration || 0)}</span>
                      <span>👥 {rec.participants?.length || 0} participants</span>
                    </div>

                    <div className="item-footer-row">
                      <span className="item-badge">{rec.format?.toUpperCase() || 'WAV'}</span>
                      <span className="item-badge">
                        📝 Transcription: {rec.transcriptionStatus}
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right Column: Recording Details, Player & Transcript (Requirements 20, 21, 22) */}
        <div className="recording-detail-panel">
          {selectedRecording ? (
            <div className="detail-content-wrapper">
              {/* Header & Quick Actions */}
              <div className="detail-header">
                <div>
                  <h2 className="detail-title">{selectedRecording.title || 'Voice Session Details'}</h2>
                  <div className="detail-meta-line">
                    <span>Started: {new Date(selectedRecording.startedAt).toLocaleString()}</span>
                    <span>• Duration: {formatDuration(selectedRecording.duration || 0)}</span>
                    <span>• Status: {selectedRecording.status}</span>
                  </div>
                </div>

                <div className="detail-actions-row">
                  <a
                    href={`/api/recordings/${selectedRecording.id}/download?type=audio`}
                    className="action-btn download-btn"
                    download
                    title="Download Mixed Audio WAV"
                  >
                    ⬇️ Audio WAV
                  </a>
                  <a
                    href={`/api/recordings/${selectedRecording.id}/download?type=transcript`}
                    className="action-btn download-btn"
                    download
                    title="Download Text Transcript"
                  >
                    ⬇️ Transcript
                  </a>
                  <a
                    href={`/api/recordings/${selectedRecording.id}/download?type=metadata`}
                    className="action-btn download-btn"
                    download
                    title="Download Metadata JSON"
                  >
                    ⬇️ Metadata
                  </a>
                  <button
                    className="action-btn delete-btn"
                    onClick={() => handleDeleteRecording(selectedRecording.id)}
                    title="Delete recording permanently"
                  >
                    🗑️ Delete
                  </button>
                </div>
              </div>

              {/* Audio Player Component (Requirement 22) */}
              <div className="recording-player-card">
                <audio
                  ref={audioRef}
                  src={`/api/recordings/${selectedRecording.id}/stream`}
                  onTimeUpdate={() => {
                    if (audioRef.current) setCurrentTime(audioRef.current.currentTime);
                  }}
                  onLoadedMetadata={() => {
                    if (audioRef.current) setPlayerDuration(audioRef.current.duration);
                  }}
                  onEnded={() => setIsPlaying(false)}
                />

                <div className="player-controls-row">
                  <button className="play-toggle-btn" onClick={togglePlay}>
                    {isPlaying ? '⏸️ Pause' : '▶️ Play'}
                  </button>

                  <div className="scrub-container">
                    <input
                      type="range"
                      min={0}
                      max={playerDuration || selectedRecording.duration || 1}
                      step={0.1}
                      value={currentTime}
                      onChange={(e) => handleSeek(parseFloat(e.target.value))}
                      className="scrub-slider"
                    />
                    <div className="time-display-row">
                      <span>{formatDuration(currentTime)}</span>
                      <span>{formatDuration(playerDuration || selectedRecording.duration || 0)}</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Participant List (Requirements 3, 7) */}
              <div className="participants-box">
                <h4>Voice Participants ({selectedRecording.participants?.length || 0})</h4>
                <div className="participants-chips">
                  {(selectedRecording.participants || []).map((p) => (
                    <span key={p.id} className="participant-chip" title={`User ID: ${p.userId}`}>
                      👤 {p.displayName} ({formatDuration((p.firstAudioTimestamp || 0) / 1000)})
                    </span>
                  ))}
                </div>
              </div>

              {/* Transcript Viewer & Synchronizer (Requirements 19, 20, 23) */}
              <div className="transcript-viewer-container">
                <div className="transcript-header-bar">
                  <h4>📝 Timestamped Transcript</h4>
                  <div className="transcript-filters">
                    <input
                      type="text"
                      placeholder="Search speech..."
                      className="transcript-search-box"
                      value={transcriptSearch}
                      onChange={(e) => setTranscriptSearch(e.target.value)}
                    />
                    {speakers.length > 0 && (
                      <select
                        className="speaker-dropdown"
                        value={speakerFilter}
                        onChange={(e) => setSpeakerFilter(e.target.value)}
                      >
                        <option value="ALL">All Speakers</option>
                        {speakers.map((spk) => (
                          <option key={spk} value={spk}>
                            {spk}
                          </option>
                        ))}
                      </select>
                    )}
                    <button className="copy-transcript-btn" onClick={handleCopyTranscript} title="Copy to clipboard">
                      📋 Copy
                    </button>
                  </div>
                </div>

                <div className="transcript-scroll-area">
                  {filteredSegments.length === 0 ? (
                    <div className="no-transcript-notice">
                      {selectedRecording.transcriptionStatus === 'PROCESSING' ||
                      selectedRecording.transcriptionStatus === 'QUEUED' ? (
                        <span>⏳ Transcription is currently processing in the background...</span>
                      ) : selectedRecording.transcript?.text ? (
                        <div className="raw-transcript-view">
                          <p>{selectedRecording.transcript.text}</p>
                        </div>
                      ) : (
                        <span>No transcript segments available for this recording session.</span>
                      )}
                    </div>
                  ) : (
                    filteredSegments.map((seg) => {
                      const isActive =
                        currentTime * 1000 >= seg.startMs && currentTime * 1000 <= seg.endMs;
                      return (
                        <div
                          key={seg.id}
                          className={`transcript-entry-row ${isActive ? 'active-speech' : ''}`}
                        >
                          <button
                            className="timestamp-seek-btn"
                            onClick={() => handleSeek(seg.startMs / 1000)}
                            title="Jump to this speech timestamp"
                          >
                            [{formatMs(seg.startMs)}]
                          </button>
                          <span className="speaker-label">{seg.speakerName || 'Speaker'}:</span>
                          <span className="speech-text">{seg.text}</span>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="empty-selection-placeholder">
              <div className="placeholder-icon">🎙️</div>
              <h3>Select a recording from the list</h3>
              <p>View synchronized audio playback, speaker attribution, and timestamped transcripts.</p>
            </div>
          )}
        </div>
      </div>

      {/* Start Recording Confirmation Modal (Requirement 4, 30: Explicit Recording Notice) */}
      {showStartModal && (
        <div className="modal-overlay">
          <div className="recording-modal-card">
            <h3 className="modal-title">🔴 Voice Channel Recording Notice</h3>
            <p className="modal-notice-text">
              Recording is about to begin in the active voice channel. This session will capture participant audio
              streams independently and store aligned lossless intermediate WAV tracks for mixing and transcription.
            </p>

            <div className="modal-field">
              <label>Session Title (Optional):</label>
              <input
                type="text"
                className="modal-input"
                placeholder="e.g. Weekly Team Discussion, Gaming Night"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
              />
            </div>

            <div className="modal-field">
              <label>Visibility Scope:</label>
              <select
                className="modal-select"
                value={newVisibility}
                onChange={(e) => setNewVisibility(e.target.value as any)}
              >
                <option value="GUILD">Server Only (Guild Members)</option>
                <option value="PRIVATE">Private (Operator Only)</option>
              </select>
            </div>

            <div className="modal-actions-row">
              <button className="btn-cancel" onClick={() => setShowStartModal(false)}>
                Cancel
              </button>
              <button className="btn-confirm-start" onClick={handleStartRecording}>
                [ START RECORDING ]
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
