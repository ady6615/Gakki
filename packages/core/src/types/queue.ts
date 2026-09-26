import type { Id, ISOTimestamp } from './common';
import type { Track } from './track';

/**
 * Queue track item stored in memory.
 */
export interface QueueTrack {
  id: string;
  name: string;
  path: string; // sanitized relative path e.g. "test.mp3" or stream URL
  duration?: number;
  addedBy?: string;
  artist?: string | null;
  album?: string | null;
  thumbnailUrl?: string | null;
  sourceProvider?: string;
  sourceUrl?: string;
  source?: string | null;
  artwork?: string | null;
}

/**
 * Isolated queue state for a single Discord guild.
 */
export interface GuildQueue {
  guildId: string;
  tracks: QueueTrack[];
}

/**
 * Display item for Discord /queue and frontend display (no internal paths).
 */
export interface QueueDisplayItem {
  position: number;
  id: string;
  name: string;
  artist?: string | null;
  album?: string | null;
  thumbnailUrl?: string | null;
  sourceProvider?: string | null;
  duration?: number;
  addedBy?: string;
  source?: string | null;
  artwork?: string | null;
}

/**
 * Playback completion reason to differentiate natural completion from manual stop/skip.
 */
export type PlaybackEndReason = 'finished' | 'skipped' | 'stopped' | 'error';

/**
 * Queue update event broadcast to WebSocket clients.
 */
export interface QueueUpdatedEvent {
  guildId: string;
  currentTrack: {
    id?: string;
    name: string;
    artist?: string | null;
    album?: string | null;
    thumbnailUrl?: string | null;
    sourceProvider?: string | null;
    duration?: number | null;
    source?: string | null;
    artwork?: string | null;
  } | null;
  queue: QueueDisplayItem[];
  length: number;
}

/** Legacy Phase 1 Queue Item (preserved for compatibility) */
export interface QueueItem {
  id: Id;
  track: Track;
  position: number;
  addedAt: ISOTimestamp;
  requestedBy: string | null;
}

/** Legacy Phase 1 Queue State */
export interface QueueState {
  guildId: string;
  items: QueueItem[];
  currentIndex: number;
  isPlaying: boolean;
  repeatMode: RepeatMode;
}

/** Queue repeat / loop modes */
export type RepeatMode = 'off' | 'track' | 'queue';
export type LoopMode = 'off' | 'track' | 'queue';

/**
 * Reusable audio filter configuration for DSP processing.
 */
export interface AudioFilterConfig {
  bassboost: boolean;
  speed: number;
  nightcore: boolean;
}

/**
 * Authoritative guild playback state.
 */
export interface GuildPlaybackState {
  guildId: string;
  currentTrack?: QueueTrack | null;
  volume: number; // 0 to 200, default 100
  filters: AudioFilterConfig;
  loopMode: LoopMode;
  stayInChannel: boolean;
  voiceIdleTimerActive: boolean;
  voiceIdleReason?: 'empty_channel' | 'queue_empty' | null;
  timeoutSeconds?: number;
}

export interface GuildSettings {
  guildId: string;
  volume: number;
  filters: AudioFilterConfig;
  loopMode: LoopMode;
  stayInChannel: boolean;
  voiceIdleTimeout: number;
}

/**
 * Guild settings update event broadcast to WebSocket clients.
 */
export interface GuildSettingsUpdatedEvent {
  type: 'guild.settings.updated';
  guildId: string;
  settings: GuildSettings;
}

/**
 * Playback settings update event broadcast to WebSocket clients.
 */
export interface PlaybackSettingsUpdatedEvent {
  type: 'playback.settings.updated';
  guildId: string;
  volume: number;
  filters: AudioFilterConfig;
  loopMode: LoopMode;
  stayInChannel: boolean;
}

/**
 * Voice lifecycle update event broadcast to WebSocket clients.
 */
export interface VoiceLifecycleUpdatedEvent {
  type: 'voice.lifecycle.updated';
  guildId: string;
  humanCount: number;
  timerActive: boolean;
  reason?: 'empty_channel' | 'queue_empty' | null;
  stayInChannel: boolean;
}

