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
export { connectDatabase, disconnectDatabase, getDatabase, getDatabasePool } from './database';
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
export { AudioFeatureManager } from './managers/audio-feature.manager';
export { TrackSimilarityService, DEFAULT_REC_PROFILES } from './managers/track-similarity.service';
export { PreferenceScoringService } from './managers/preference-scoring.service';
export { DynamicDJManager, type DynamicDJContext } from './managers/dynamic-dj.manager';
export { LyricsManager } from './managers/lyrics.manager';
export { RecordingManager } from './managers/recording.manager';
export { VoiceLifecycleManager } from './managers/voice-lifecycle.manager';
export { GuildSettingsManager } from './managers/guild-settings.manager';
export { TransitionFeatureManager } from './managers/transition-feature.manager';
export { TransitionEngine } from './services/transition-engine';
export { KeyCompatibilityService } from './services/key-compatibility.service';
export { CuePointService } from './services/cue-point.service';
export { StemManager } from './managers/stem.manager';
export { VocalActivityService } from './services/vocal-activity.service';
export { VocalClashService } from './services/vocal-clash.service';
export { LayeredTransitionEngine } from './services/layered-transition-engine';
export { FavoritesManager } from './managers/favorites.manager';
export { LibraryManager } from './managers/library.manager';
export { LrcLibLyricsProvider } from './services/lyrics/lrclib.provider';
export { MockLyricsProvider } from './services/lyrics/mock.provider';
export { LyricsProviderRegistry } from './services/lyrics/lyrics-provider.registry';
export { parseLrcLyrics, findActiveLyricLineIndex } from './utils/lrc-parser';
export { computeLyricsMatchConfidence, normalizeSongString, stringSimilarity } from './utils/lyrics-matcher';
export { AudioRoutingManager } from './managers/audio-routing.manager';
export * from './transcription';



