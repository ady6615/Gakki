-- Phase 6 Migration: Playback Events, Playlists & Analytics

-- 1. Extend or create playback_events with complete Phase 6 columns
DO $$
BEGIN
  -- Add user_id if not present
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'playback_events' AND column_name = 'user_id') THEN
    ALTER TABLE playback_events ADD COLUMN user_id VARCHAR(100);
  END IF;

  -- Add started_at if not present
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'playback_events' AND column_name = 'started_at') THEN
    ALTER TABLE playback_events ADD COLUMN started_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  END IF;

  -- Add ended_at if not present
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'playback_events' AND column_name = 'ended_at') THEN
    ALTER TABLE playback_events ADD COLUMN ended_at TIMESTAMPTZ;
  END IF;

  -- Add duration_listened if not present
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'playback_events' AND column_name = 'duration_listened') THEN
    ALTER TABLE playback_events ADD COLUMN duration_listened INTEGER NOT NULL DEFAULT 0;
  END IF;

  -- Add track_duration if not present
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'playback_events' AND column_name = 'track_duration') THEN
    ALTER TABLE playback_events ADD COLUMN track_duration INTEGER;
  END IF;

  -- Add completed if not present
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'playback_events' AND column_name = 'completed') THEN
    ALTER TABLE playback_events ADD COLUMN completed BOOLEAN NOT NULL DEFAULT FALSE;
  END IF;

  -- Add end_reason if not present
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'playback_events' AND column_name = 'end_reason') THEN
    ALTER TABLE playback_events ADD COLUMN end_reason VARCHAR(50);
  END IF;

  -- Add source if not present
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'playback_events' AND column_name = 'source') THEN
    ALTER TABLE playback_events ADD COLUMN source VARCHAR(100);
  END IF;

  -- Add session_id if not present
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'playback_events' AND column_name = 'session_id') THEN
    ALTER TABLE playback_events ADD COLUMN session_id VARCHAR(100);
  END IF;

  -- Add created_at if not present
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'playback_events' AND column_name = 'created_at') THEN
    ALTER TABLE playback_events ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  END IF;

  -- Ensure platform has default 'discord' if nullable
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'playback_events' AND column_name = 'platform') THEN
    ALTER TABLE playback_events ALTER COLUMN platform SET DEFAULT 'discord';
    ALTER TABLE playback_events ALTER COLUMN platform DROP NOT NULL;
  END IF;
END $$;

-- 2. Extend playlists with Phase 6 columns
DO $$
BEGIN
  -- Add owner_user_id
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'playlists' AND column_name = 'owner_user_id') THEN
    ALTER TABLE playlists ADD COLUMN owner_user_id VARCHAR(100);
  END IF;

  -- Add guild_id
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'playlists' AND column_name = 'guild_id') THEN
    ALTER TABLE playlists ADD COLUMN guild_id VARCHAR(100);
  END IF;

  -- Add visibility
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'playlists' AND column_name = 'visibility') THEN
    ALTER TABLE playlists ADD COLUMN visibility VARCHAR(50) NOT NULL DEFAULT 'guild';
  END IF;
END $$;

-- 3. Extend playlist_tracks with Phase 6 columns
DO $$
BEGIN
  -- Add added_by
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'playlist_tracks' AND column_name = 'added_by') THEN
    ALTER TABLE playlist_tracks ADD COLUMN added_by VARCHAR(100);
  END IF;
END $$;

-- 4. Create performance and query indexes
CREATE INDEX IF NOT EXISTS idx_playback_events_guild_started ON playback_events(guild_id, started_at);
CREATE INDEX IF NOT EXISTS idx_playback_events_track_started ON playback_events(track_id, started_at);
CREATE INDEX IF NOT EXISTS idx_playback_events_session ON playback_events(session_id);
CREATE INDEX IF NOT EXISTS idx_playback_events_user ON playback_events(user_id);
CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist_position ON playlist_tracks(playlist_id, position);
CREATE INDEX IF NOT EXISTS idx_playlists_guild ON playlists(guild_id);
CREATE INDEX IF NOT EXISTS idx_playlists_owner ON playlists(owner_user_id);
