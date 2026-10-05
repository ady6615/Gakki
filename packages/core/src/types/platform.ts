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
import type { AudioFilterConfig } from './queue';

/** Play options passed to adapter.play() */
export interface AdapterPlayOptions {
  volume?: number;
  filters?: AudioFilterConfig;
  seekSeconds?: number;
}

/** Connection state for a platform adapter */
export type PlatformConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

/** Information about a voice channel the adapter can join */
export interface VoiceChannelInfo {
  channelId: string;
  guildId: string;
  name: string;
}

/**
 * Phase 13: Unified Platform Capabilities
 * Describes exact native capabilities exposed by each platform adapter.
 */
export interface VoicePlatformCapabilities {
  sendAudio: boolean;
  receiveAudio: boolean;
  receiveVideo: boolean;
  participantMetadata: boolean;
  recording: boolean;
}

/**
 * Phase 13: Platform-Neutral Participant Model
 * Normalizes Discord, Google Meet, and Desktop participants.
 */
export interface PlatformParticipant {
  platform: 'discord' | 'google_meet' | 'desktop' | string;
  platformParticipantId: string;
  displayName?: string;
  sessionId?: string;
  isAnonymous?: boolean;
  isPhone?: boolean;
  avatarUrl?: string;
  joinedAt?: Date;
  leftAt?: Date;
  isSpeaking?: boolean;
}

/**
 * Phase 13: Platform-Neutral Voice Session
 * Common abstraction for Discord VC, Desktop audio, Google Meet conferences, etc.
 */
export interface VoiceSession {
  id: string;
  platform: string;
  sessionId: string;
  guildId?: string;
  channelId?: string;
  spaceId?: string;
  participants: Map<string, PlatformParticipant>;
  audioInputs: string[];
  audioOutputs: string[];
  capabilities: VoicePlatformCapabilities;
  status: 'active' | 'idle' | 'closed';
  startedAt: Date;
  endedAt?: Date;
  metadata?: Record<string, any>;
}

/**
 * Interface that all platform adapters must implement.
 *
 * The core engine interacts with platforms exclusively through this interface,
 * ensuring zero coupling to any specific platform's API.
 */
export interface PlatformAdapter {
  /** Unique identifier for this platform (e.g., 'discord', 'desktop', 'google_meet') */
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
 * Handles voice channel joining, leaving, audio player subscription, and capability reporting.
 */
export interface VoicePlatformAdapter {
  readonly platform: string;

  joinVoice(guildId: string, channelId: string, options?: unknown): Promise<void>;
  leaveVoice(guildId: string): Promise<void>;
  getVoiceStatus(guildId: string): VoiceConnectionStatus;

  play(guildId: string, source: AudioSource, options?: AdapterPlayOptions): Promise<void>;
  pause(guildId: string): boolean;
  resume(guildId: string): boolean;
  stop(guildId: string): boolean;

  setVolume?(guildId: string, volume: number): void;
  rebuildCurrentStream?(guildId: string, filters: AudioFilterConfig, seekSeconds?: number): Promise<void>;
  getPlaybackDuration?(guildId: string): number;
  getHumanCount?(guildId: string): number;

  getPlaybackStatus(guildId: string): PlaybackStatus;
  getCurrentTrack(guildId: string): AudioTrackInfo | null;
  getState(guildId: string): VoicePlatformState;

  /** Phase 13: Capability and session reflection */
  getCapabilities?(): VoicePlatformCapabilities;
  getSession?(guildId?: string): VoiceSession | null;
  getParticipants?(guildId?: string): PlatformParticipant[];

  onStateChange(listener: (state: VoicePlatformState) => void): void;
  onError(listener: (guildId: string, error: Error) => void): void;
  onTrackEnd?(listener: (guildId: string) => void): void;
  onParticipantUpdate?(listener: (participants: PlatformParticipant[]) => void): void;
}
