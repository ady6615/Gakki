-- Phase 5 Initial Schema Migration for Gakki Music Platform

CREATE TABLE IF NOT EXISTS tracks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(500) NOT NULL,
  artist VARCHAR(500),
  album VARCHAR(500),
  album_artist VARCHAR(500),
  duration INTEGER,
  genre VARCHAR(200),
  year INTEGER,
  track_number INTEGER,
  cover_art TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS track_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  track_id UUID NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  provider VARCHAR(100) NOT NULL,
  source_type VARCHAR(50) NOT NULL,
  source_url TEXT NOT NULL,
  external_id VARCHAR(500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_verified_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id VARCHAR(100) PRIMARY KEY,
  volume INTEGER NOT NULL DEFAULT 100,
  bassboost BOOLEAN NOT NULL DEFAULT FALSE,
  speed REAL NOT NULL DEFAULT 1.0,
  nightcore BOOLEAN NOT NULL DEFAULT FALSE,
  loop_mode VARCHAR(20) NOT NULL DEFAULT 'off',
  stay_in_channel BOOLEAN NOT NULL DEFAULT FALSE,
  voice_idle_timeout INTEGER NOT NULL DEFAULT 300,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS playlists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS playlist_tracks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  playlist_id UUID NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id UUID NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS playback_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  track_id UUID NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  guild_id VARCHAR(100),
  platform VARCHAR(50) NOT NULL,
  played_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  duration_played_seconds INTEGER
);

-- Indices for query performance
CREATE INDEX IF NOT EXISTS idx_track_sources_track_id ON track_sources(track_id);
CREATE INDEX IF NOT EXISTS idx_track_sources_provider ON track_sources(provider, external_id);
CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist_id ON playlist_tracks(playlist_id);
CREATE INDEX IF NOT EXISTS idx_playback_events_guild_id ON playback_events(guild_id);
