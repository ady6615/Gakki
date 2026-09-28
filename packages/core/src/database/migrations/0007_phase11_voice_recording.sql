-- Phase 11 Migration: Voice Recording, Participants, Transcripts & Audit Log

-- 1. Recording Sessions
CREATE TABLE IF NOT EXISTS recording_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id VARCHAR(100) NOT NULL,
  voice_channel_id VARCHAR(100) NOT NULL,
  started_by VARCHAR(100) NOT NULL,
  started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  ended_at TIMESTAMP WITH TIME ZONE,
  duration INTEGER DEFAULT 0 NOT NULL,
  status VARCHAR(50) DEFAULT 'PENDING' NOT NULL, -- PENDING, RECORDING, PROCESSING, COMPLETED, FAILED, DELETED
  storage_key TEXT,
  format VARCHAR(20) DEFAULT 'wav' NOT NULL, -- wav, flac, opus
  file_size_bytes BIGINT DEFAULT 0,
  transcription_status VARCHAR(50) DEFAULT 'NONE' NOT NULL, -- NONE, QUEUED, PROCESSING, COMPLETED, FAILED
  visibility VARCHAR(50) DEFAULT 'GUILD' NOT NULL, -- PRIVATE, GUILD
  title VARCHAR(255),
  metadata_storage_key TEXT,
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

-- 2. Recording Participants
CREATE TABLE IF NOT EXISTS recording_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id UUID NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
  user_id VARCHAR(100) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  left_at TIMESTAMP WITH TIME ZONE,
  first_audio_timestamp BIGINT DEFAULT 0,
  last_audio_timestamp BIGINT DEFAULT 0,
  audio_storage_key TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

-- 3. Transcripts
CREATE TABLE IF NOT EXISTS transcripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id UUID NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
  provider VARCHAR(100) NOT NULL,
  model VARCHAR(100) NOT NULL,
  language VARCHAR(50) DEFAULT 'en',
  text TEXT NOT NULL,
  status VARCHAR(50) DEFAULT 'COMPLETED' NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

-- 4. Transcript Segments (timestamped for clickable seeking & speaker attribution)
CREATE TABLE IF NOT EXISTS transcript_segments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transcript_id UUID NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  recording_id UUID NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
  speaker_id VARCHAR(100),
  speaker_name VARCHAR(255) NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  text TEXT NOT NULL,
  confidence REAL DEFAULT 1.0 NOT NULL,
  position INTEGER NOT NULL
);

-- 5. Recording Audit Events (auditing every action)
CREATE TABLE IF NOT EXISTS recording_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id UUID NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
  actor_user_id VARCHAR(100) NOT NULL,
  action VARCHAR(100) NOT NULL, -- STARTED, STOPPED, DOWNLOADED, VIEWED, DELETED, TRANSCRIPTION_REQUESTED
  timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  details TEXT
);

-- 6. Performance & Search Indexes
CREATE INDEX IF NOT EXISTS idx_recording_sessions_guild ON recording_sessions(guild_id);
CREATE INDEX IF NOT EXISTS idx_recording_sessions_started_by ON recording_sessions(started_by);
CREATE INDEX IF NOT EXISTS idx_recording_sessions_status ON recording_sessions(status);
CREATE INDEX IF NOT EXISTS idx_recording_sessions_created_at ON recording_sessions(created_at);
CREATE INDEX IF NOT EXISTS idx_recording_participants_rec ON recording_participants(recording_id);
CREATE INDEX IF NOT EXISTS idx_recording_participants_user ON recording_participants(user_id);
CREATE INDEX IF NOT EXISTS idx_transcripts_recording ON transcripts(recording_id);
CREATE INDEX IF NOT EXISTS idx_transcript_segments_transcript ON transcript_segments(transcript_id);
CREATE INDEX IF NOT EXISTS idx_transcript_segments_recording ON transcript_segments(recording_id);
CREATE INDEX IF NOT EXISTS idx_transcript_segments_search ON transcript_segments(LOWER(text));
CREATE INDEX IF NOT EXISTS idx_recording_audit_rec ON recording_audit_events(recording_id);
CREATE INDEX IF NOT EXISTS idx_recording_audit_actor ON recording_audit_events(actor_user_id);
