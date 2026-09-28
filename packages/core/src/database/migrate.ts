import * as fs from 'node:fs';
import * as path from 'node:path';
import type pg from 'pg';
import { createLogger } from '../utils/logger';

const logger = createLogger('database-migrate');

/**
 * Builtin SQL migration definition for fallback when running compiled in dist or bundle.
 */
const BUILTIN_MIGRATIONS: Array<{ name: string; sql: string }> = [
  {
    name: '0001_phase5_init.sql',
    sql: `
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

      CREATE INDEX IF NOT EXISTS idx_track_sources_track_id ON track_sources(track_id);
      CREATE INDEX IF NOT EXISTS idx_track_sources_provider ON track_sources(provider, external_id);
      CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist_id ON playlist_tracks(playlist_id);
      CREATE INDEX IF NOT EXISTS idx_playback_events_guild_id ON playback_events(guild_id);
    `,
  },
  {
    name: '0002_phase6_history_playlists.sql',
    sql: `
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'playback_events' AND column_name = 'user_id') THEN
          ALTER TABLE playback_events ADD COLUMN user_id VARCHAR(100);
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'playback_events' AND column_name = 'started_at') THEN
          ALTER TABLE playback_events ADD COLUMN started_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'playback_events' AND column_name = 'ended_at') THEN
          ALTER TABLE playback_events ADD COLUMN ended_at TIMESTAMPTZ;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'playback_events' AND column_name = 'duration_listened') THEN
          ALTER TABLE playback_events ADD COLUMN duration_listened INTEGER NOT NULL DEFAULT 0;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'playback_events' AND column_name = 'track_duration') THEN
          ALTER TABLE playback_events ADD COLUMN track_duration INTEGER;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'playback_events' AND column_name = 'completed') THEN
          ALTER TABLE playback_events ADD COLUMN completed BOOLEAN NOT NULL DEFAULT FALSE;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'playback_events' AND column_name = 'end_reason') THEN
          ALTER TABLE playback_events ADD COLUMN end_reason VARCHAR(50);
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'playback_events' AND column_name = 'source') THEN
          ALTER TABLE playback_events ADD COLUMN source VARCHAR(100);
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'playback_events' AND column_name = 'session_id') THEN
          ALTER TABLE playback_events ADD COLUMN session_id VARCHAR(100);
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'playback_events' AND column_name = 'created_at') THEN
          ALTER TABLE playback_events ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
        END IF;

        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'playback_events' AND column_name = 'platform') THEN
          ALTER TABLE playback_events ALTER COLUMN platform SET DEFAULT 'discord';
          ALTER TABLE playback_events ALTER COLUMN platform DROP NOT NULL;
        END IF;
      END $$;

      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'playlists' AND column_name = 'owner_user_id') THEN
          ALTER TABLE playlists ADD COLUMN owner_user_id VARCHAR(100);
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'playlists' AND column_name = 'guild_id') THEN
          ALTER TABLE playlists ADD COLUMN guild_id VARCHAR(100);
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'playlists' AND column_name = 'visibility') THEN
          ALTER TABLE playlists ADD COLUMN visibility VARCHAR(50) NOT NULL DEFAULT 'guild';
        END IF;
      END $$;

      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'playlist_tracks' AND column_name = 'added_by') THEN
          ALTER TABLE playlist_tracks ADD COLUMN added_by VARCHAR(100);
        END IF;
      END $$;

      CREATE INDEX IF NOT EXISTS idx_playback_events_guild_started ON playback_events(guild_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_playback_events_track_started ON playback_events(track_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_playback_events_session ON playback_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_playback_events_user ON playback_events(user_id);
      CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist_position ON playlist_tracks(playlist_id, position);
      CREATE INDEX IF NOT EXISTS idx_playlists_guild ON playlists(guild_id);
      CREATE INDEX IF NOT EXISTS idx_playlists_owner ON playlists(owner_user_id);
    `,
  },
  {
    name: '0003_phase7_audio_analysis_vectors.sql',
    sql: `
      DO $$
      BEGIN
        CREATE EXTENSION IF NOT EXISTS vector;
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END $$;

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

      CREATE INDEX IF NOT EXISTS idx_track_features_status ON track_features(analysis_status);
      CREATE INDEX IF NOT EXISTS idx_track_features_hash ON track_features(content_hash);
      CREATE INDEX IF NOT EXISTS idx_track_features_energy ON track_features(energy);
      CREATE INDEX IF NOT EXISTS idx_track_features_bpm ON track_features(bpm);
    `,
  },
  {
    name: '0004_phase8_transitions.sql',
    sql: `
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

      CREATE INDEX IF NOT EXISTS idx_track_transition_features_status ON track_transition_features(analysis_status);
      CREATE INDEX IF NOT EXISTS idx_track_transition_features_camelot ON track_transition_features(camelot_code);
    `,
  },
];

/**
 * Execute pending database migrations against PostgreSQL.
 *
 * @param pool - PostgreSQL connection pool
 */
export async function runMigrations(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    // 1. Ensure migrations tracking table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS __gakki_migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // 2. Discover migration files
    const migrationsDir = path.resolve(__dirname, 'migrations');
    let migrationsToRun: Array<{ name: string; sql: string }> = [];

    if (fs.existsSync(migrationsDir)) {
      const files = fs
        .readdirSync(migrationsDir)
        .filter((f) => f.endsWith('.sql'))
        .sort();

      for (const file of files) {
        const fullPath = path.join(migrationsDir, file);
        const sql = fs.readFileSync(fullPath, 'utf-8');
        migrationsToRun.push({ name: file, sql });
      }
    }

    if (migrationsToRun.length === 0) {
      migrationsToRun = BUILTIN_MIGRATIONS;
    }

    // 3. Query already applied migrations
    const res = await client.query<{ name: string }>('SELECT name FROM __gakki_migrations');
    const appliedNames = new Set(res.rows.map((r) => r.name));

    // 4. Apply pending migrations sequentially inside transactions
    for (const migration of migrationsToRun) {
      if (appliedNames.has(migration.name)) {
        continue;
      }

      logger.info({ migration: migration.name }, '[DB] Applying migration: %s', migration.name);

      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO __gakki_migrations (name) VALUES ($1)', [migration.name]);
        await client.query('COMMIT');
        logger.info({ migration: migration.name }, '[DB] Migration applied successfully: %s', migration.name);
      } catch (err) {
        await client.query('ROLLBACK');
        logger.error({ err, migration: migration.name }, '[DB] Migration failed: %s', migration.name);
        throw err;
      }
    }
  } finally {
    client.release();
  }
}
