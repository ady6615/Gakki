-- Phase 7 Migration: Audio Features, pgvector Embeddings & Analysis Tracking

-- 1. Enable pgvector extension if available
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION WHEN OTHERS THEN
  -- Vector extension may not be installed in all environments; proceed gracefully
  NULL;
END $$;

-- 2. Create track_features table
CREATE TABLE IF NOT EXISTS track_features (
  track_id UUID PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  feature_version INTEGER NOT NULL DEFAULT 1,
  bpm REAL,
  tempo_confidence REAL,
  energy REAL,
  key VARCHAR(20),
  spectral_centroid REAL,
  spectral_bandwidth REAL,
  spectral_contrast REAL,
  spectral_rolloff REAL,
  spectral_flatness REAL,
  zero_crossing_rate REAL,
  chroma TEXT,
  mfcc TEXT,
  rhythm_features TEXT,
  embedding TEXT,
  analysis_status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  content_hash VARCHAR(64),
  analyzed_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Conditionally add native pgvector column if extension is active
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    BEGIN
      ALTER TABLE track_features ADD COLUMN IF NOT EXISTS vector_embedding vector(32);
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;
END $$;

-- 4. Indexes for fast status checks, deduplication, and feature lookups
CREATE INDEX IF NOT EXISTS idx_track_features_status ON track_features(analysis_status);
CREATE INDEX IF NOT EXISTS idx_track_features_hash ON track_features(content_hash);
CREATE INDEX IF NOT EXISTS idx_track_features_energy ON track_features(energy);
CREATE INDEX IF NOT EXISTS idx_track_features_bpm ON track_features(bpm);
