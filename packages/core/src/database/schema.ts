import { pgTable, uuid, varchar, integer, timestamp, text } from 'drizzle-orm/pg-core';

/**
 * Database schema for the Gakki music platform.
 *
 * Uses Drizzle ORM for type-safe PostgreSQL schema definition.
 * This schema is the single source of truth for both migrations
 * and TypeScript types derived from the database.
 *
 * Note: pgvector columns for audio embeddings will be added here
 * when the AI recommendation system is implemented.
 */

/** Audio tracks — any playable audio item regardless of source */
export const tracks = pgTable('tracks', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: varchar('title', { length: 500 }).notNull(),
  artist: varchar('artist', { length: 500 }),
  album: varchar('album', { length: 500 }),
  durationSeconds: integer('duration_seconds'),
  filePath: text('file_path'),
  sourceType: varchar('source_type', { length: 50 }).notNull(),
  sourceId: varchar('source_id', { length: 500 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/** Playlists — named, ordered collections of tracks */
export const playlists = pgTable('playlists', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
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
  addedAt: timestamp('added_at', { withTimezone: true }).defaultNow().notNull(),
});

/** Playback event log — every play event recorded for analytics */
export const playbackEvents = pgTable('playback_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  trackId: uuid('track_id')
    .notNull()
    .references(() => tracks.id, { onDelete: 'cascade' }),
  guildId: varchar('guild_id', { length: 100 }),
  platform: varchar('platform', { length: 50 }).notNull(),
  playedAt: timestamp('played_at', { withTimezone: true }).defaultNow().notNull(),
  durationPlayedSeconds: integer('duration_played_seconds'),
});
