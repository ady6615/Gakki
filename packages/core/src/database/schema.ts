import { pgTable, uuid, varchar, integer, timestamp, text, boolean, real } from 'drizzle-orm/pg-core';

/**
 * Database schema for the Gakki music platform.
 *
 * Uses Drizzle ORM for type-safe PostgreSQL schema definition.
 * Single source of truth for migrations and TypeScript types.
 */

/** Audio tracks — core metadata entity */
export const tracks = pgTable('tracks', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: varchar('title', { length: 500 }).notNull(),
  artist: varchar('artist', { length: 500 }),
  album: varchar('album', { length: 500 }),
  albumArtist: varchar('album_artist', { length: 500 }),
  duration: integer('duration'), // duration in seconds
  genre: varchar('genre', { length: 200 }),
  year: integer('year'),
  trackNumber: integer('track_number'),
  coverArt: text('cover_art'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/** Track sources — separating tracks from their audio sources (local file, stream, URL) */
export const trackSources = pgTable('track_sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  trackId: uuid('track_id')
    .notNull()
    .references(() => tracks.id, { onDelete: 'cascade' }),
  provider: varchar('provider', { length: 100 }).notNull(), // 'local', 'http_stream', 'soundcloud', etc.
  sourceType: varchar('source_type', { length: 50 }).notNull(), // 'file', 'stream', 'url'
  sourceUrl: text('source_url').notNull(),
  externalId: varchar('external_id', { length: 500 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
});

/** Persistent Guild Settings — survives bot restarts */
export const guildSettings = pgTable('guild_settings', {
  guildId: varchar('guild_id', { length: 100 }).primaryKey(),
  volume: integer('volume').notNull().default(100),
  bassboost: boolean('bassboost').notNull().default(false),
  speed: real('speed').notNull().default(1.0),
  nightcore: boolean('nightcore').notNull().default(false),
  loopMode: varchar('loop_mode', { length: 20 }).notNull().default('off'),
  stayInChannel: boolean('stay_in_channel').notNull().default(false),
  voiceIdleTimeout: integer('voice_idle_timeout').notNull().default(300),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/** Playlists — named, ordered collections of tracks */
export const playlists = pgTable('playlists', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  ownerUserId: varchar('owner_user_id', { length: 100 }),
  guildId: varchar('guild_id', { length: 100 }),
  visibility: varchar('visibility', { length: 50 }).notNull().default('guild'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/** Junction table: tracks within playlists, with ordering */
export const playlistTracks = pgTable('playlist_tracks', {
  id: uuid('id').primaryKey().defaultRandom(),
  playlistId: uuid('playlist_id')
    .notNull()
    .references(() => playlists.id, { onDelete: 'cascade' }),
  trackId: uuid('track_id')
    .notNull()
    .references(() => tracks.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  addedBy: varchar('added_by', { length: 100 }),
  addedAt: timestamp('added_at', { withTimezone: true }).defaultNow().notNull(),
});

/** Playback event log — recorded for history & analytics */
export const playbackEvents = pgTable('playback_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  guildId: varchar('guild_id', { length: 100 }),
  trackId: uuid('track_id')
    .notNull()
    .references(() => tracks.id, { onDelete: 'cascade' }),
  userId: varchar('user_id', { length: 100 }),
  platform: varchar('platform', { length: 50 }).default('discord'),
  startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  durationListened: integer('duration_listened').notNull().default(0),
  trackDuration: integer('track_duration'),
  completed: boolean('completed').notNull().default(false),
  endReason: varchar('end_reason', { length: 50 }), // 'finished' | 'skipped' | 'stopped' | 'error'
  source: varchar('source', { length: 100 }),
  sessionId: varchar('session_id', { length: 100 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/** Track acoustic features & embeddings for smart recommendations */
export const trackFeatures = pgTable('track_features', {
  trackId: uuid('track_id')
    .primaryKey()
    .references(() => tracks.id, { onDelete: 'cascade' }),
  featureVersion: integer('feature_version').notNull().default(1),
  bpm: real('bpm'),
  tempoConfidence: real('tempo_confidence'),
  energy: real('energy'), // normalized acoustic energy [0, 1]
  key: varchar('key', { length: 20 }),
  spectralCentroid: real('spectral_centroid'),
  spectralBandwidth: real('spectral_bandwidth'),
  spectralContrast: real('spectral_contrast'),
  spectralRolloff: real('spectral_rolloff'),
  spectralFlatness: real('spectral_flatness'),
  zeroCrossingRate: real('zero_crossing_rate'),
  chroma: text('chroma'), // JSON string array of 12 chroma values
  mfcc: text('mfcc'), // JSON string array of 13 MFCC values
  rhythmFeatures: text('rhythm_features'), // JSON string of rhythm features
  embedding: text('embedding'), // JSON string of 32-dim normalized vector
  analysisStatus: varchar('analysis_status', { length: 32 }).notNull().default('PENDING'), // PENDING | PROCESSING | READY | FAILED
  contentHash: varchar('content_hash', { length: 64 }),
  analyzedAt: timestamp('analyzed_at', { withTimezone: true }),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
