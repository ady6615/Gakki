/**
 * @gakki/core — Platform-agnostic music engine
 *
 * This package contains all business logic, types, and database access
 * for the Gakki music platform. It has ZERO coupling to Discord, Express,
 * or any other platform/framework.
 *
 * Platform-specific code lives in @gakki/server and communicates with
 * core through the PlatformAdapter interface and manager classes.
 */

// Types
export * from './types';

// Database
export { connectDatabase, disconnectDatabase, getDatabase } from './database';
export type { DatabaseClient } from './database';
export { schema } from './database';

// Utilities
export { createLogger } from './utils/logger';
export { loadConfig } from './utils/config';
export type { AppConfig } from './utils/config';

// Audio
export * from './audio';

// Managers
export { QueueManager } from './managers/queue.manager';
export { TrackManager } from './managers/track.manager';
export { PlaylistManager } from './managers/playlist.manager';
export { PlaybackManager } from './managers/playback.manager';
export { AudioPlayerManager } from './managers/audio-player.manager';
export { AudioSourceManager } from './managers/audio-source.manager';
export { AnalyticsManager } from './managers/analytics.manager';
export { AiRecommendationManager } from './managers/ai-recommendation.manager';
export { LyricsManager } from './managers/lyrics.manager';
export { RecordingManager } from './managers/recording.manager';

