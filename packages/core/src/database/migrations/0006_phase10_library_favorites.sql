-- Migration 0006: Phase 10 Library, User Favorites, Lyrics Cache & Search Indexes

-- 1. User Favorites Table
CREATE TABLE IF NOT EXISTS user_favorites (
  user_id VARCHAR(100) NOT NULL,
  track_id UUID NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, track_id)
);

CREATE INDEX IF NOT EXISTS idx_user_favorites_user_id ON user_favorites(user_id);
CREATE INDEX IF NOT EXISTS idx_user_favorites_created_at ON user_favorites(user_id, created_at DESC);

-- 2. Playlist Enhancements
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'playlists' AND column_name = 'cover_art') THEN
    ALTER TABLE playlists ADD COLUMN cover_art TEXT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'playlists' AND column_name = 'is_favorite') THEN
    ALTER TABLE playlists ADD COLUMN is_favorite BOOLEAN DEFAULT FALSE;
  END IF;
END $$;

-- 3. Lyrics Cache Table
CREATE TABLE IF NOT EXISTS track_lyrics_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  track_id UUID REFERENCES tracks(id) ON DELETE CASCADE,
  artist VARCHAR(500),
  title VARCHAR(500) NOT NULL,
  provider VARCHAR(50) NOT NULL,
  plain_lyrics TEXT NOT NULL,
  synced_lyrics JSONB,
  is_synced BOOLEAN DEFAULT FALSE,
  confidence REAL DEFAULT 1.0,
  attribution TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_lyrics_track UNIQUE (track_id)
);

CREATE INDEX IF NOT EXISTS idx_lyrics_cache_title_artist ON track_lyrics_cache(LOWER(title), LOWER(artist));

-- 4. Search & Performance Indexes for Library & Analytics
CREATE INDEX IF NOT EXISTS idx_tracks_title_lower ON tracks(LOWER(title));
CREATE INDEX IF NOT EXISTS idx_tracks_artist_lower ON tracks(LOWER(artist));
CREATE INDEX IF NOT EXISTS idx_tracks_album_lower ON tracks(LOWER(album));
CREATE INDEX IF NOT EXISTS idx_playback_events_started_at ON playback_events(started_at);
CREATE INDEX IF NOT EXISTS idx_playback_events_guild_started ON playback_events(guild_id, started_at);
CREATE INDEX IF NOT EXISTS idx_playback_events_user_started ON playback_events(user_id, started_at);
CREATE INDEX IF NOT EXISTS idx_playlists_name_lower ON playlists(LOWER(name));
