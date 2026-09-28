-- Phase 8 Migration: Seamless Audio Mixing, Crossfading & Advanced DJ Transitions

-- 1. Extend guild_settings with transition configuration columns
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'guild_settings' AND column_name = 'transition_enabled') THEN
    ALTER TABLE guild_settings ADD COLUMN transition_enabled BOOLEAN NOT NULL DEFAULT TRUE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'guild_settings' AND column_name = 'transition_duration') THEN
    ALTER TABLE guild_settings ADD COLUMN transition_duration INTEGER NOT NULL DEFAULT 6;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'guild_settings' AND column_name = 'transition_profile') THEN
    ALTER TABLE guild_settings ADD COLUMN transition_profile VARCHAR(32) NOT NULL DEFAULT 'BALANCED';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'guild_settings' AND column_name = 'harmonic_mixing') THEN
    ALTER TABLE guild_settings ADD COLUMN harmonic_mixing BOOLEAN NOT NULL DEFAULT TRUE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'guild_settings' AND column_name = 'auto_tempo') THEN
    ALTER TABLE guild_settings ADD COLUMN auto_tempo BOOLEAN NOT NULL DEFAULT TRUE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'guild_settings' AND column_name = 'loudness_normalize') THEN
    ALTER TABLE guild_settings ADD COLUMN loudness_normalize BOOLEAN NOT NULL DEFAULT TRUE;
  END IF;
END $$;

-- 2. Create track_transition_features table
CREATE TABLE IF NOT EXISTS track_transition_features (
  track_id UUID PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  feature_version INTEGER NOT NULL DEFAULT 1,
  integrated_loudness_lufs REAL,
  loudness_range_lu REAL,
  true_peak_dbtp REAL,
  track_gain_db REAL,
  beat_grid TEXT,
  beat_confidence REAL,
  phrase_boundaries TEXT,
  intro_start REAL,
  intro_end REAL,
  intro_energy REAL,
  outro_start REAL,
  outro_end REAL,
  outro_energy REAL,
  drop_candidates TEXT,
  key VARCHAR(20),
  key_confidence REAL,
  camelot_code VARCHAR(10),
  structure_confidence REAL,
  analysis_status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  analyzed_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Indexes for fast status checks and harmonic lookups
CREATE INDEX IF NOT EXISTS idx_track_transition_features_status ON track_transition_features(analysis_status);
CREATE INDEX IF NOT EXISTS idx_track_transition_features_camelot ON track_transition_features(camelot_code);
