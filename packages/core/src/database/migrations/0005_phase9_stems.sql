-- Phase 9 Migration: Stem Separation, Vocal Clash Prevention & Layered DJ Mixing

-- 1. Extend guild_settings with stem separation and vocal mixing settings
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'guild_settings' AND column_name = 'stem_separation_enabled') THEN
    ALTER TABLE guild_settings ADD COLUMN stem_separation_enabled BOOLEAN NOT NULL DEFAULT TRUE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'guild_settings' AND column_name = 'vocal_clash_prevention') THEN
    ALTER TABLE guild_settings ADD COLUMN vocal_clash_prevention BOOLEAN NOT NULL DEFAULT TRUE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'guild_settings' AND column_name = 'vocal_ducking') THEN
    ALTER TABLE guild_settings ADD COLUMN vocal_ducking BOOLEAN NOT NULL DEFAULT TRUE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'guild_settings' AND column_name = 'vocal_duck_db') THEN
    ALTER TABLE guild_settings ADD COLUMN vocal_duck_db REAL NOT NULL DEFAULT 6.0;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'guild_settings' AND column_name = 'layered_transitions') THEN
    ALTER TABLE guild_settings ADD COLUMN layered_transitions BOOLEAN NOT NULL DEFAULT TRUE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'guild_settings' AND column_name = 'stem_provider_preference') THEN
    ALTER TABLE guild_settings ADD COLUMN stem_provider_preference VARCHAR(32) NOT NULL DEFAULT 'auto';
  END IF;
END $$;

-- 2. Create track_stems table
CREATE TABLE IF NOT EXISTS track_stems (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  track_id UUID NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  provider VARCHAR(32) NOT NULL,
  model_name VARCHAR(64) NOT NULL,
  model_version VARCHAR(32) NOT NULL,
  analysis_version INTEGER NOT NULL DEFAULT 1,
  vocals_path TEXT NOT NULL,
  drums_path TEXT NOT NULL,
  bass_path TEXT NOT NULL,
  other_path TEXT NOT NULL,
  duration REAL NOT NULL,
  sample_rate INTEGER NOT NULL DEFAULT 44100,
  channels INTEGER NOT NULL DEFAULT 2,
  vocal_confidence REAL DEFAULT 0.8,
  quality_score REAL DEFAULT 0.85,
  storage_mode VARCHAR(20) NOT NULL DEFAULT 'persistent',
  status VARCHAR(32) NOT NULL DEFAULT 'READY',
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  CONSTRAINT uq_track_stems_model UNIQUE (track_id, provider, model_name, model_version)
);

CREATE INDEX IF NOT EXISTS idx_track_stems_track_id ON track_stems(track_id);
CREATE INDEX IF NOT EXISTS idx_track_stems_status ON track_stems(status);
CREATE INDEX IF NOT EXISTS idx_track_stems_expires ON track_stems(expires_at) WHERE expires_at IS NOT NULL;

-- 3. Create track_vocal_features table
CREATE TABLE IF NOT EXISTS track_vocal_features (
  track_id UUID PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  feature_version INTEGER NOT NULL DEFAULT 1,
  mean_vocal_activity REAL NOT NULL DEFAULT 0.0,
  vocal_activity_envelope TEXT, -- JSON array of { t, v }
  vocal_start_seconds REAL,
  vocal_end_seconds REAL,
  vocal_intensity REAL DEFAULT 0.0,
  vocal_confidence REAL DEFAULT 0.8,
  instrumental_outro_start REAL,
  instrumental_outro_end REAL,
  instrumental_intensity REAL DEFAULT 0.0,
  analysis_status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_track_vocal_features_status ON track_vocal_features(analysis_status);
