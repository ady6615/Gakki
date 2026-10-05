/**
 * Phase 13: AI DJ Voice Commentary & TTS Types
 */

import type { TransitionProfile, TransitionPlan } from './transition';
import type { DJProfile } from './recommendation';

export type DJCommentaryTrigger =
  | 'DJ_START'
  | 'PLAYLIST_START'
  | 'VIBE_PLAYLIST'
  | 'ENERGY_TRANSITION'
  | 'SPECIAL_TRANSITION'
  | 'USER_REQUEST'
  | 'TRACK_TRANSITION'
  | 'REGULAR_INTERVAL';

export type CommentaryMixingMode = 'BETWEEN_SONGS' | 'DUCKED_VOICE_OVER_MUSIC';

export interface DJTrackContext {
  id: string;
  title: string;
  artist?: string | null;
  album?: string | null;
  genre?: string | null;
  bpm?: number | null;
  energy?: number | null;
  key?: string | null;
  camelotCode?: string | null;
  duration?: number | null;
}

export interface DJCommentaryContext {
  guildId: string;
  trigger: DJCommentaryTrigger;
  fromTrack?: DJTrackContext | null;
  toTrack?: DJTrackContext | null;
  transitionPlan?: TransitionPlan | null;
  djProfile?: DJProfile | null;
  transitionProfile?: TransitionProfile | null;
  energyDelta?: number | null;
  userPrompt?: string | null;
  lastCommentaryTimestampMs?: number;
}

export interface DJCommentary {
  id: string;
  text: string;
  trigger: DJCommentaryTrigger;
  voiceProfile: string;
  audioBuffer?: Buffer | null;
  audioFormat?: {
    sampleRate: number;
    channels: number;
    encoding: string;
  };
  durationSeconds?: number;
  pregeneratedAt?: string;
  readyForPlayback: boolean;
  mixingMode: CommentaryMixingMode;
}

export interface DJCommentaryConfig {
  enabled: boolean;
  cooldownSeconds: number; // e.g. 180 seconds
  mixingMode: CommentaryMixingMode;
  duckingVolumeMultiplier: number; // e.g. 0.25 (-12dB)
  duckingAttackMs: number; // e.g. 300ms
  duckingReleaseMs: number; // e.g. 500ms
  voiceProfile: string; // e.g. 'Aoede', 'Puck', 'Fenrir'
  maxCommentaryLengthWords: number; // e.g. 25 words
  allowVoiceOverMusic: boolean;
}

export interface TTSOptions {
  voice?: string;
  sampleRate?: number; // 24000 or 48000
  speakingRate?: number; // 1.0
  pitch?: number; // 0.0
}

export interface TTSAudioResult {
  audioBuffer: Buffer;
  format: {
    sampleRate: number;
    channels: number;
    bitDepth: number;
    encoding: 'pcm_s16le' | 'wav' | 'mp3';
  };
  durationSeconds: number;
  latencyMs: number;
  provider: string;
}
