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
  transitionEnabled: boolean('transition_enabled').notNull().default(true),
  transitionDuration: integer('transition_duration').notNull().default(6),
  transitionProfile: varchar('transition_profile', { length: 32 }).notNull().default('BALANCED'),
  harmonicMixing: boolean('harmonic_mixing').notNull().default(true),
  autoTempo: boolean('auto_tempo').notNull().default(true),
  loudnessNormalize: boolean('loudness_normalize').notNull().default(true),
  // Phase 9: Stem separation & vocal mixing settings
  stemSeparationEnabled: boolean('stem_separation_enabled').notNull().default(true),
  vocalClashPrevention: boolean('vocal_clash_prevention').notNull().default(true),
  vocalDucking: boolean('vocal_ducking').notNull().default(true),
  vocalDuckDb: real('vocal_duck_db').notNull().default(6.0),
  layeredTransitions: boolean('layered_transitions').notNull().default(true),
  stemProviderPreference: varchar('stem_provider_preference', { length: 32 }).notNull().default('auto'),
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
  coverArt: text('cover_art'),
  isFavorite: boolean('is_favorite').default(false),
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

/** User Favorites (Phase 10) — persistent user-level saved tracks */
export const userFavorites = pgTable('user_favorites', {
  userId: varchar('user_id', { length: 100 }).notNull(),
  trackId: uuid('track_id')
    .notNull()
    .references(() => tracks.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/** Track Lyrics Cache (Phase 10) — cached lyrics from provider lookup */
export const trackLyricsCache = pgTable('track_lyrics_cache', {
  id: uuid('id').primaryKey().defaultRandom(),
  trackId: uuid('track_id').references(() => tracks.id, { onDelete: 'cascade' }),
  artist: varchar('artist', { length: 500 }),
  title: varchar('title', { length: 500 }).notNull(),
  provider: varchar('provider', { length: 50 }).notNull(),
  plainLyrics: text('plain_lyrics').notNull(),
  syncedLyrics: text('synced_lyrics'), // JSON string of LyricsLine[]
  isSynced: boolean('is_synced').default(false),
  confidence: real('confidence').default(1.0),
  attribution: text('attribution'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
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

/** Track transition features for Phase 8 DJ mixing & crossfading */
export const trackTransitionFeatures = pgTable('track_transition_features', {
  trackId: uuid('track_id')
    .primaryKey()
    .references(() => tracks.id, { onDelete: 'cascade' }),
  featureVersion: integer('feature_version').notNull().default(1),
  integratedLoudnessLufs: real('integrated_loudness_lufs'),
  loudnessRangeLu: real('loudness_range_lu'),
  truePeakDbtp: real('true_peak_dbtp'),
  trackGainDb: real('track_gain_db'),
  beatGrid: text('beat_grid'), // JSON array of beat timestamps (seconds)
  beatConfidence: real('beat_confidence'),
  phraseBoundaries: text('phrase_boundaries'), // JSON object of phrase arrays
  introStart: real('intro_start'),
  introEnd: real('intro_end'),
  introEnergy: real('intro_energy'),
  outroStart: real('outro_start'),
  outroEnd: real('outro_end'),
  outroEnergy: real('outro_energy'),
  dropCandidates: text('drop_candidates'), // JSON array of candidate timestamps
  key: varchar('key', { length: 20 }),
  keyConfidence: real('key_confidence'),
  camelotCode: varchar('camelot_code', { length: 10 }),
  structureConfidence: real('structure_confidence'),
  analysisStatus: varchar('analysis_status', { length: 32 }).notNull().default('PENDING'),
  analyzedAt: timestamp('analyzed_at', { withTimezone: true }),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/** Track stems for Phase 9 source separation (vocals, drums, bass, other) */
export const trackStems = pgTable('track_stems', {
  id: uuid('id').primaryKey().defaultRandom(),
  trackId: uuid('track_id')
    .notNull()
    .references(() => tracks.id, { onDelete: 'cascade' }),
  provider: varchar('provider', { length: 32 }).notNull(),
  modelName: varchar('model_name', { length: 64 }).notNull(),
  modelVersion: varchar('model_version', { length: 32 }).notNull(),
  analysisVersion: integer('analysis_version').notNull().default(1),
  vocalsPath: text('vocals_path').notNull(),
  drumsPath: text('drums_path').notNull(),
  bassPath: text('bass_path').notNull(),
  otherPath: text('other_path').notNull(),
  duration: real('duration').notNull(),
  sampleRate: integer('sample_rate').notNull().default(44100),
  channels: integer('channels').notNull().default(2),
  vocalConfidence: real('vocal_confidence').default(0.8),
  qualityScore: real('quality_score').default(0.85),
  storageMode: varchar('storage_mode', { length: 20 }).notNull().default('persistent'),
  status: varchar('status', { length: 32 }).notNull().default('READY'),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
});

/** Track vocal features for Phase 9 vocal clash detection & ducking */
export const trackVocalFeatures = pgTable('track_vocal_features', {
  trackId: uuid('track_id')
    .primaryKey()
    .references(() => tracks.id, { onDelete: 'cascade' }),
  featureVersion: integer('feature_version').notNull().default(1),
  meanVocalActivity: real('mean_vocal_activity').notNull().default(0.0),
  vocalActivityEnvelope: text('vocal_activity_envelope'), // JSON string of { t, v }[]
  vocalStartSeconds: real('vocal_start_seconds'),
  vocalEndSeconds: real('vocal_end_seconds'),
  vocalIntensity: real('vocal_intensity').default(0.0),
  vocalConfidence: real('vocal_confidence').default(0.8),
  instrumentalOutroStart: real('instrumental_outro_start'),
  instrumentalOutroEnd: real('instrumental_outro_end'),
  instrumentalIntensity: real('instrumental_intensity').default(0.0),
  analysisStatus: varchar('analysis_status', { length: 32 }).notNull().default('PENDING'),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});


