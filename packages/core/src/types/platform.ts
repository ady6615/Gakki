/**
 * Platform Adapter Interface
 *
 * This is the abstraction layer that decouples the core music engine
 * from any specific voice/chat platform (Discord, Google Meet, Desktop, etc.).
 *
 * Each platform implements this interface to bridge its native APIs
 * with the Gakki core engine.
 */

import type { AudioSource } from '../audio/audio-source';
import type { AudioTrackInfo, PlaybackStatus, VoiceConnectionStatus, VoicePlatformState } from './audio';

/** Connection state for a platform adapter */
export type PlatformConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

/** Information about a voice channel the adapter can join */
export interface VoiceChannelInfo {
  channelId: string;
  guildId: string;
  name: string;
}

/**
 * Interface that all platform adapters must implement.
 *
 * The core engine interacts with platforms exclusively through this interface,
 * ensuring zero coupling to any specific platform's API.
 */
export interface PlatformAdapter {
  /** Unique identifier for this platform (e.g., 'discord', 'desktop') */
  readonly platform: string;

  /** Current connection state */
  readonly state: PlatformConnectionState;

  /** Connect to the platform */
  connect(): Promise<void>;

  /** Disconnect from the platform */
  disconnect(): Promise<void>;

  /** Check if connected and ready */
  isConnected(): boolean;
}

/**
 * Interface for platform voice adapters (Discord, Google Meet, Desktop audio).
 * Handles voice channel joining, leaving, and audio player subscription.
 */
export interface VoicePlatformAdapter {
  readonly platform: string;

  joinVoice(guildId: string, channelId: string, options?: unknown): Promise<void>;
  leaveVoice(guildId: string): Promise<void>;
  getVoiceStatus(guildId: string): VoiceConnectionStatus;

  play(guildId: string, source: AudioSource): Promise<void>;
  pause(guildId: string): boolean;
  resume(guildId: string): boolean;
  stop(guildId: string): boolean;

  getPlaybackStatus(guildId: string): PlaybackStatus;
  getCurrentTrack(guildId: string): AudioTrackInfo | null;
  getState(guildId: string): VoicePlatformState;

  onStateChange(listener: (state: VoicePlatformState) => void): void;
  onError(listener: (guildId: string, error: Error) => void): void;
  onTrackEnd?(listener: (guildId: string) => void): void;
}


