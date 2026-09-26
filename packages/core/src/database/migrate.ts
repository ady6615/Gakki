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
