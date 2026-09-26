/**
 * Audio and Voice playback types for Gakki platform.
 */

export type VoiceConnectionStatus = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'ERROR';

export type PlaybackStatus = 'IDLE' | 'PLAYING' | 'PAUSED' | 'ERROR';

export interface AudioTrackInfo {
  name: string;
  duration: number | null;
  artist?: string | null;
  filePath?: string | null;
  sourceType: string;
}

export interface VoicePlatformState {
  guildId: string;
  voiceState: VoiceConnectionStatus;
  playerState: PlaybackStatus;
  track: AudioTrackInfo | null;
}

export interface AudioMetadata {
  title: string;
  artist?: string | null;
  album?: string | null;
  duration?: number | null;
}
