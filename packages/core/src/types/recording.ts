/**
 * Voice Recording API & Storage Contract (Phase 10 Preparation).
 *
 * NOTE: Full voice recording is intentionally NOT implemented in Phase 10.
 * This file specifies the architectural contracts, data models, and retention
 * policy for future phases.
 */

export type AudioRecordingFormat = 'wav' | 'flac' | 'opus';

export type RecordingSessionStatus = 'INITIALIZING' | 'RECORDING' | 'PAUSED' | 'FINALIZING' | 'SAVED' | 'FAILED';

export interface ParticipantRecordingMetadata {
  userId: string;
  username: string;
  joinedAt: string;
  leftAt?: string;
  audioTrackPath?: string;
  sampleRate: number;
  channels: number;
}

export interface VoiceRecordingSession {
  id: string;
  guildId: string;
  channelId: string;
  startedByUserId: string;
  startedAt: string;
  endedAt?: string;
  status: RecordingSessionStatus;
  format: AudioRecordingFormat;
  retentionDays: number;
  participants: ParticipantRecordingMetadata[];
  masterFilePath?: string;
  metadataFilePath?: string;
  error?: string;
}

export interface RecordingStartOptions {
  guildId: string;
  channelId: string;
  requestedByUserId: string;
  format?: AudioRecordingFormat;
  retentionDays?: number;
  stereoMix?: boolean;
  separateUserTracks?: boolean;
}

export interface RecordingResult {
  sessionId: string;
  guildId: string;
  channelId: string;
  durationSeconds: number;
  filePath: string;
  fileSizeBytes: number;
  format: AudioRecordingFormat;
  participantCount: number;
  completedAt: string;
}

export interface VoiceRecordingService {
  start(options: RecordingStartOptions): Promise<VoiceRecordingSession>;
  stop(sessionId: string): Promise<RecordingResult>;
  getSession(sessionId: string): Promise<VoiceRecordingSession | null>;
  listSessions(guildId: string): Promise<VoiceRecordingSession[]>;
  deleteSession(sessionId: string): Promise<boolean>;
}
