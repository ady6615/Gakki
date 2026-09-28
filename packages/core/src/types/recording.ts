/**
 * Voice Recording, Transcription & Audit Models (Phase 11).
 *
 * Provides end-to-end data contracts for actual voice recording,
 * per-participant audio streams, mixer, asynchronous transcription,
 * and administrative audit logging.
 */

export type AudioRecordingFormat = 'wav' | 'flac' | 'opus';

export type RecordingSessionStatus =
  | 'PENDING'
  | 'RECORDING'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED'
  | 'DELETED';

export type RecordingVisibility = 'PRIVATE' | 'GUILD';

export type TranscriptionStatus =
  | 'NONE'
  | 'QUEUED'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED';

export interface ParticipantRecordingMetadata {
  id?: string;
  recordingId?: string;
  userId: string;
  displayName: string;
  joinedAt: string;
  leftAt?: string;
  firstAudioTimestamp: number; // in ms relative to session start
  lastAudioTimestamp: number;  // in ms relative to session start
  audioStorageKey?: string;
  fileSizeBytes?: number;
}

export interface VoiceRecordingSession {
  id: string;
  guildId: string;
  voiceChannelId: string;
  startedBy: string;
  startedAt: string;
  endedAt?: string;
  duration: number; // in seconds
  status: RecordingSessionStatus;
  storageKey?: string;
  format: AudioRecordingFormat;
  fileSizeBytes: number;
  transcriptionStatus: TranscriptionStatus;
  visibility: RecordingVisibility;
  title?: string;
  metadataStorageKey?: string;
  errorMessage?: string;
  participants: ParticipantRecordingMetadata[];
  createdAt: string;
  updatedAt: string;
}

export interface RecordingStartOptions {
  guildId: string;
  voiceChannelId: string;
  startedBy: string;
  format?: AudioRecordingFormat;
  visibility?: RecordingVisibility;
  title?: string;
  retentionDays?: number;
  separateUserTracks?: boolean;
}

export interface RecordingResult {
  sessionId: string;
  guildId: string;
  voiceChannelId: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  format: AudioRecordingFormat;
  storageKey: string;
  fileSizeBytes: number;
  participantCount: number;
  participants: ParticipantRecordingMetadata[];
  status: RecordingSessionStatus;
}

export interface TranscriptSegment {
  id: string;
  transcriptId: string;
  recordingId: string;
  speakerId?: string | null;
  speakerName: string;
  startMs: number;
  endMs: number;
  text: string;
  confidence: number;
  position: number;
}

export interface RecordingTranscript {
  id: string;
  recordingId: string;
  provider: string;
  model: string;
  language: string;
  text: string;
  status: string;
  segments: TranscriptSegment[];
  createdAt: string;
  updatedAt: string;
}

export interface RecordingAuditEvent {
  id: string;
  recordingId: string;
  actorUserId: string;
  action:
    | 'STARTED'
    | 'STOPPED'
    | 'DOWNLOADED'
    | 'VIEWED'
    | 'DELETED'
    | 'TRANSCRIPTION_REQUESTED';
  timestamp: string;
  details?: string;
}

export interface RecordingFilterOptions {
  guildId?: string;
  userId?: string;
  status?: RecordingSessionStatus;
  transcriptionStatus?: TranscriptionStatus;
  visibility?: RecordingVisibility;
  dateFrom?: Date | string;
  dateTo?: Date | string;
  durationMin?: number;
  durationMax?: number;
  searchQuery?: string;
  limit?: number;
  offset?: number;
}

export interface RecordingMetadataJSON {
  recordingId: string;
  guildId: string;
  voiceChannelId: string;
  startedBy: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  format: string;
  fileSizeBytes: number;
  sampleRate: number;
  channels: number;
  participants: Array<{
    userId: string;
    displayName: string;
    joinedAt: string;
    leftAt?: string;
    firstAudioMs: number;
    lastAudioMs: number;
    audioFile?: string;
  }>;
}

export interface VoiceRecordingService {
  start(options: RecordingStartOptions): Promise<VoiceRecordingSession>;
  stop(sessionId: string): Promise<RecordingResult>;
  getSession(sessionId: string): Promise<VoiceRecordingSession | null>;
  listSessions(filters?: RecordingFilterOptions): Promise<VoiceRecordingSession[]>;
  deleteSession(sessionId: string, actorUserId?: string): Promise<boolean>;
  getActiveSession(guildId: string): Promise<VoiceRecordingSession | null>;
}
