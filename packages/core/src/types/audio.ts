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

export type PlaybackTarget = 'discord' | 'desktop' | 'virtual';

export interface AudioDevice {
  id: string;
  name: string;
  type: 'output' | 'input';
  sampleRate?: number;
  channelCount?: number;
  isDefault?: boolean;
  isVirtual?: boolean;
}

export interface AudioStreamFormat {
  sampleRate: number; // baseline 48000
  channels: number; // baseline 2 (stereo)
  bitDepth?: number; // baseline 16 or 32
  encoding?: 'pcm_s16le' | 'pcm_f32le' | 'opus' | 'wav';
}

export interface AudioStream {
  stream: import('node:stream').Readable;
  format: AudioStreamFormat;
  metadata?: Record<string, any>;
}

export interface AudioRoutingState {
  target: PlaybackTarget;
  outputDeviceId: string;
  inputDeviceId: string;
  monitoringEnabled: boolean;
  monitorDeviceId: string;
  activeOutputs: AudioDevice[];
  activeInputs: AudioDevice[];
}

