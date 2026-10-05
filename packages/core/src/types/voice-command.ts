/**
 * Phase 13: Voice Commands, Gemini Voice Agent & Google Meet Integration
 * Core Voice Command & Intent Types
 */

import type { CommandPermissionLevel } from './permissions';

/** Allowed Voice Intents */
export type VoiceIntentType =
  | 'PLAY_TRACK'
  | 'PAUSE'
  | 'RESUME'
  | 'SKIP'
  | 'STOP'
  | 'SET_VOLUME'
  | 'SHUFFLE'
  | 'SMART_SHUFFLE'
  | 'ENABLE_DJ'
  | 'DISABLE_DJ'
  | 'NEXT'
  | 'SHOW_LYRICS'
  | 'SAVE_FAVORITE'
  | 'PLAY_PLAYLIST'
  | 'SET_LOOP'
  | 'CLARIFY_AMBIGUITY'
  | 'CONVERSATIONAL_QUERY'
  | 'UNKNOWN';

/** Structured Voice Intent */
export interface VoiceIntent {
  intent: VoiceIntentType;
  query?: string;
  volume?: number;
  playlistName?: string;
  loopMode?: 'off' | 'track' | 'queue';
  confidence: number;
  rawTranscript?: string;
  isConversational?: boolean;
  conversationalResponse?: string;
  clarificationNeeded?: boolean;
  clarificationPrompt?: string;
  candidateTracks?: Array<{
    id: string;
    title: string;
    artist?: string | null;
    duration?: number | null;
  }>;
}

/** Voice Command Execution Context */
export interface VoiceCommandContext {
  platform: 'discord' | 'desktop' | 'google_meet' | string;
  guildId?: string;
  voiceChannelId?: string;
  userId: string;
  userDisplayName?: string;
  permissionLevel: CommandPermissionLevel;
  currentTrackId?: string | null;
  currentTrackTitle?: string | null;
  currentArtist?: string | null;
}

/** Voice Command Execution Result */
export interface VoiceCommandResult {
  success: boolean;
  intent: VoiceIntentType;
  message: string;
  executedAction?: string;
  audioResponse?: Buffer | null;
  needsClarification?: boolean;
  clarificationOptions?: Array<{
    id: string;
    title: string;
    artist?: string | null;
  }>;
  latencyMs: number;
  provider: 'gemini_live' | 'local_deterministic' | 'stt_parser';
}

/** Voice Activity Detection (VAD) State & Events */
export type VADState = 'silence' | 'speech';

export interface VADEvent {
  state: VADState;
  timestampMs: number;
  energyRms: number;
  speechDurationMs?: number;
  silenceDurationMs?: number;
}

export interface VADOptions {
  energyThresholdRms?: number; // e.g. 0.015 - 0.035
  silenceHangoverMs?: number; // e.g. 350ms
  minSpeechDurationMs?: number; // e.g. 150ms
  sampleRate?: number; // default 16000
}

/** Local Wake Word Result */
export interface WakeWordResult {
  detected: boolean;
  keyword: string;
  confidence: number;
  timestampMs: number;
  audioBuffer?: Buffer;
}

/** Global Voice Engine Status */
export type VoiceEngineStatus =
  | 'OFF'
  | 'IDLE_LISTENING'
  | 'WAKE_WORD_DETECTED'
  | 'PROCESSING_COMMAND'
  | 'SPEAKING_RESPONSE'
  | 'ERROR';

export interface VoiceEngineState {
  enabled: boolean;
  status: VoiceEngineStatus;
  activeInputDevice: string | null;
  isVadActive: boolean;
  lastWakeWordAt?: string | null;
  lastCommandAt?: string | null;
  lastIntent?: VoiceIntentType | null;
  geminiLiveConnected: boolean;
  isBargeInActive: boolean;
}
