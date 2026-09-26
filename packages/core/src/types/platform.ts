/**
 * Platform Adapter Interface
 *
 * This is the abstraction layer that decouples the core music engine
 * from any specific voice/chat platform (Discord, Google Meet, Desktop, etc.).
 *
 * Each platform implements this interface to bridge its native APIs
 * with the Gakki core engine.
 */

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
 *
 * Phase 1 defines connection lifecycle only. Audio playback methods
 * (play, pause, stop, join/leave voice) will be added when the
 * playback pipeline is implemented.
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
