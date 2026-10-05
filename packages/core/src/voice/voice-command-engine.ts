/**
 * Voice Command Engine
 *
 * Implements Requirements 1, 2, 3, 4, 7, 8, 9, 10, 11, 13, 33, 35, 36, 37:
 * - End-to-end voice pipeline: AudioInput -> VAD -> Wake Word -> STT/Gemini -> Validated Intent -> Music Engine.
 * - Strict structured intent validation & backend permission checks.
 * - Ambiguity handling & conversational clarification prompts.
 * - Voice interruption (barge-in) support.
 * - Privacy state management (Voice Commands ON/OFF).
 * - Deterministic local command matcher fallback when offline.
 */

import { EventEmitter } from 'node:events';
import type { AudioInput } from '../audio/audio-input.interface';
import { VoiceActivityDetector } from '../audio/vad-detector';
import { WakeWordDetector } from '../audio/wake-word-detector';
import { AudioResampler } from '../audio/audio-resampler';
import { VoiceResponseOutput } from './voice-response-output';
import { LocalCommandMatcher } from './local-command-matcher';
import { validateVoiceIntent } from './intent-schema';
import type {
  VoiceCommandContext,
  VoiceCommandResult,
  VoiceEngineState,
  VoiceIntent,
} from '../types/voice-command';
import { CommandPermissionLevel } from '../types/permissions';
import { createLogger } from '../utils/logger';

const logger = createLogger('voice-command-engine');

export interface MusicEngineCallbacks {
  playTrack: (query: string, context: VoiceCommandContext) => Promise<{ success: boolean; trackName?: string; error?: string }>;
  pause: (context: VoiceCommandContext) => Promise<boolean>;
  resume: (context: VoiceCommandContext) => Promise<boolean>;
  skip: (context: VoiceCommandContext) => Promise<boolean>;
  stop: (context: VoiceCommandContext) => Promise<boolean>;
  setVolume: (volume: number, context: VoiceCommandContext) => Promise<boolean>;
  smartShuffle: (context: VoiceCommandContext) => Promise<boolean>;
  enableDJ: (context: VoiceCommandContext) => Promise<boolean>;
  disableDJ: (context: VoiceCommandContext) => Promise<boolean>;
  playPlaylist: (name: string, context: VoiceCommandContext) => Promise<boolean>;
  showLyrics: (context: VoiceCommandContext) => Promise<{ success: boolean; lyrics?: string }>;
  saveFavorite: (context: VoiceCommandContext) => Promise<boolean>;
  setLoop: (mode: 'off' | 'track' | 'queue', context: VoiceCommandContext) => Promise<boolean>;
  searchLibrary: (query: string) => Promise<Array<{ id: string; title: string; artist?: string | null; duration?: number | null }>>;
}

export class VoiceCommandEngine extends EventEmitter {
  private enabled = false;
  private isListening = false;
  private isWakeWordDetected = false;
  private activeDeviceId: string | null = null;

  private readonly vad: VoiceActivityDetector;
  private readonly wakeWord: WakeWordDetector;
  private readonly voiceResponse: VoiceResponseOutput;

  private musicCallbacks?: MusicEngineCallbacks;
  private geminiProvider?: any; // GeminiLiveVoiceProvider (injected)
  private pendingClarification: { context: VoiceCommandContext; candidates: Array<{ id: string; title: string; artist?: string | null }> } | null = null;

  private lastWakeWordAt: string | null = null;
  private lastCommandAt: string | null = null;
  private lastIntent: any = null;

  constructor(options?: {
    vad?: VoiceActivityDetector;
    wakeWord?: WakeWordDetector;
    voiceResponse?: VoiceResponseOutput;
  }) {
    super();
    this.vad = options?.vad || new VoiceActivityDetector();
    this.wakeWord = options?.wakeWord || new WakeWordDetector();
    this.voiceResponse = options?.voiceResponse || new VoiceResponseOutput();

    this.setupListeners();
  }

  private setupListeners(): void {
    // VAD speech start -> trigger barge-in if Gakki is currently speaking
    this.vad.on('speech_start', (event) => {
      if (this.voiceResponse.isCurrentlySpeaking()) {
        logger.info('[VOICE] User started speaking while AI was speaking — triggering barge-in interruption');
        this.voiceResponse.interrupt();
        this.emit('barge_in', { timestampMs: event.timestampMs });
      }
    });

    // Wake word detected locally
    this.wakeWord.on('wake_word_detected', (res) => {
      if (!this.enabled) return;
      this.isWakeWordDetected = true;
      this.lastWakeWordAt = new Date().toISOString();
      logger.info({ confidence: res.confidence }, '[VOICE] Wake word detected ("Hey Gakki")');
      this.emit('wake_word_detected', res);
    });
  }

  setMusicCallbacks(callbacks: MusicEngineCallbacks): void {
    this.musicCallbacks = callbacks;
  }

  setGeminiProvider(provider: any): void {
    this.geminiProvider = provider;
  }

  getVoiceResponseOutput(): VoiceResponseOutput {
    return this.voiceResponse;
  }

  getVAD(): VoiceActivityDetector {
    return this.vad;
  }

  getWakeWordDetector(): WakeWordDetector {
    return this.wakeWord;
  }

  getState(): VoiceEngineState {
    return {
      enabled: this.enabled,
      status: !this.enabled
        ? 'OFF'
        : this.isWakeWordDetected
          ? 'WAKE_WORD_DETECTED'
          : this.voiceResponse.isCurrentlySpeaking()
            ? 'SPEAKING_RESPONSE'
            : this.isListening
              ? 'IDLE_LISTENING'
              : 'OFF',
      activeInputDevice: this.activeDeviceId,
      isVadActive: this.vad.isSpeechActive(),
      lastWakeWordAt: this.lastWakeWordAt,
      lastCommandAt: this.lastCommandAt,
      lastIntent: this.lastIntent,
      geminiLiveConnected: Boolean(this.geminiProvider?.isConnected?.()),
      isBargeInActive: !this.voiceResponse.isCurrentlySpeaking(),
    };
  }

  /**
   * Requirement 36: Enable or disable voice commands.
   * When disabled:
   * - microphone capture stops
   * - Gemini Live session closes
   * - no microphone audio is captured or streamed
   */
  async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    if (enabled) {
      this.wakeWord.startListening();
      this.isListening = true;
      logger.info('[VOICE] Voice Commands enabled (🎤 ON)');
    } else {
      this.wakeWord.stopListening();
      this.vad.reset();
      this.voiceResponse.interrupt();
      this.isListening = false;
      this.isWakeWordDetected = false;
      this.pendingClarification = null;

      if (this.geminiProvider?.close) {
        await this.geminiProvider.close();
      }
      logger.info('[VOICE] Voice Commands disabled (🎤 OFF) — capture & cloud sessions stopped');
    }
    this.emit('state_changed', this.getState());
  }

  /**
   * Processes incoming raw microphone audio chunk (48kHz or 16kHz PCM).
   * Runs Resampling -> VAD -> Wake Word -> Cloud/Local routing.
   */
  processMicrophonePcm(rawPcm: Buffer, sourceSampleRate = 48000): void {
    if (!this.enabled) return;

    // Resample to 16kHz mono 16-bit PCM for VAD and Gemini Live
    const pcm16k =
      sourceSampleRate === 48000
        ? AudioResampler.downsample48kTo16kMono(rawPcm, 1)
        : rawPcm;

    if (pcm16k.length === 0) return;

    // 1. Run local Voice Activity Detection (Requirement 4)
    const vadEvent = this.vad.processFrame(pcm16k);
    if (vadEvent.state === 'silence') {
      // Do not stream continuous silence to network
      return;
    }

    // 2. Run local Wake Word Detection if not already triggered (Requirement 2)
    if (!this.isWakeWordDetected) {
      this.wakeWord.processPcmChunk(pcm16k);
      return;
    }

    // 3. If wake word is active, forward audio to Gemini Live or local buffer
    if (this.geminiProvider?.isConnected?.()) {
      this.geminiProvider.sendAudioPcm16k(pcm16k);
    }
  }

  /**
   * Processes a recognized text transcript or direct voice command.
   * Resolves Ambiguity, validates permissions, and executes action.
   */
  async executeVoiceCommand(
    transcript: string,
    context: VoiceCommandContext,
  ): Promise<VoiceCommandResult> {
    const startTime = Date.now();
    this.lastCommandAt = new Date().toISOString();

    logger.info({ transcript, user: context.userDisplayName, platform: context.platform }, '[VOICE] Recognition started');

    // 1. If we are waiting for ambiguity clarification
    if (this.pendingClarification) {
      const result = await this.resolveClarification(transcript, context, startTime);
      return result;
    }

    // 2. Parse intent: try Gemini or deterministic local command matcher (Requirement 35)
    let parsedIntent: VoiceIntent | null = null;
    let provider: 'gemini_live' | 'local_deterministic' | 'stt_parser' = 'local_deterministic';

    // Local deterministic parser (instant offline match)
    parsedIntent = LocalCommandMatcher.match(transcript);

    // If local match didn't resolve and Gemini is available, query Gemini
    if (!parsedIntent && this.geminiProvider?.parseTranscriptIntent) {
      try {
        parsedIntent = await this.geminiProvider.parseTranscriptIntent(transcript, context);
        provider = 'gemini_live';
      } catch (err) {
        logger.warn({ err }, '[GEMINI] Cloud intent parsing failed — falling back to unknown');
      }
    }

    if (!parsedIntent) {
      parsedIntent = {
        intent: 'UNKNOWN',
        confidence: 0.2,
        rawTranscript: transcript,
        isConversational: true,
        conversationalResponse: "I didn't quite catch that. You can say play, pause, skip, smart shuffle, or ask for recommendations.",
      };
    }

    this.lastIntent = parsedIntent.intent;

    // 3. Validate against strict Intent schema and permission system (Requirements 7, 10)
    const validation = validateVoiceIntent(parsedIntent, context.permissionLevel);
    if (!validation.valid) {
      logger.warn({ intent: parsedIntent.intent, error: validation.error }, '[VOICE] Command rejected due to permissions/schema');
      return {
        success: false,
        intent: parsedIntent.intent,
        message: validation.error || 'Command rejected',
        latencyMs: Date.now() - startTime,
        provider,
      };
    }

    const intent = validation.intent!;

    // 4. Check for ambiguous play queries (Requirement 9)
    if (intent.intent === 'PLAY_TRACK' && intent.query && this.musicCallbacks) {
      const candidates = await this.musicCallbacks.searchLibrary(intent.query);
      if (candidates.length > 1) {
        // Ambiguous search result -> ask for clarification
        this.pendingClarification = { context, candidates };
        const prompt = `I found several tracks for "${intent.query}": ${candidates
          .slice(0, 3)
          .map((c, i) => `${i + 1}) ${c.title}${c.artist ? ` by ${c.artist}` : ''}`)
          .join(', ')}. Which one do you mean?`;

        logger.info({ query: intent.query, count: candidates.length }, '[VOICE] Ambiguous query detected — prompting for clarification');

        return {
          success: true,
          intent: 'CLARIFY_AMBIGUITY',
          message: prompt,
          needsClarification: true,
          clarificationOptions: candidates.slice(0, 5),
          latencyMs: Date.now() - startTime,
          provider,
        };
      }
    }

    // 5. Execute action on Music Engine via whitelisted handlers (Requirement 8)
    const execResult = await this.dispatchIntentToMusicEngine(intent, context);
    const latencyMs = Date.now() - startTime;

    this.isWakeWordDetected = false;
    this.emit('intent_executed', {
      intent: intent.intent,
      success: execResult.success,
      latencyMs,
      user: context.userDisplayName,
    });

    logger.info(
      { intent: intent.intent, success: execResult.success, latencyMs },
      '[VOICE] Command executed successfully',
    );

    return {
      success: execResult.success,
      intent: intent.intent,
      message: execResult.message,
      executedAction: execResult.action,
      latencyMs,
      provider,
    };
  }

  /**
   * Dispatches a validated intent to the music callbacks.
   */
  private async dispatchIntentToMusicEngine(
    intent: VoiceIntent,
    context: VoiceCommandContext,
  ): Promise<{ success: boolean; message: string; action?: string }> {
    if (!this.musicCallbacks) {
      return { success: false, message: 'Music engine callbacks not initialized' };
    }

    switch (intent.intent) {
      case 'PLAY_TRACK': {
        const res = await this.musicCallbacks.playTrack(intent.query || '', context);
        return {
          success: res.success,
          message: res.success ? `Playing ${res.trackName || intent.query}` : (res.error || 'Failed to play track'),
          action: 'playTrack',
        };
      }

      case 'PAUSE': {
        const ok = await this.musicCallbacks.pause(context);
        return { success: ok, message: ok ? 'Playback paused' : 'Failed to pause', action: 'pause' };
      }

      case 'RESUME': {
        const ok = await this.musicCallbacks.resume(context);
        return { success: ok, message: ok ? 'Playback resumed' : 'Failed to resume', action: 'resume' };
      }

      case 'SKIP':
      case 'NEXT': {
        const ok = await this.musicCallbacks.skip(context);
        return { success: ok, message: ok ? 'Skipped to next track' : 'Failed to skip', action: 'skip' };
      }

      case 'STOP': {
        const ok = await this.musicCallbacks.stop(context);
        return { success: ok, message: ok ? 'Playback stopped' : 'Failed to stop', action: 'stop' };
      }

      case 'SET_VOLUME': {
        const vol = intent.volume ?? 50;
        const ok = await this.musicCallbacks.setVolume(vol, context);
        return { success: ok, message: ok ? `Volume set to ${vol}%` : 'Failed to set volume', action: 'setVolume' };
      }

      case 'SMART_SHUFFLE': {
        const ok = await this.musicCallbacks.smartShuffle(context);
        return { success: ok, message: ok ? 'Smart shuffle enabled' : 'Failed to shuffle', action: 'smartShuffle' };
      }

      case 'ENABLE_DJ': {
        const ok = await this.musicCallbacks.enableDJ(context);
        return { success: ok, message: ok ? 'AI DJ mode enabled' : 'Failed to enable DJ', action: 'enableDJ' };
      }

      case 'DISABLE_DJ': {
        const ok = await this.musicCallbacks.disableDJ(context);
        return { success: ok, message: ok ? 'AI DJ mode disabled' : 'Failed to disable DJ', action: 'disableDJ' };
      }

      case 'PLAY_PLAYLIST': {
        const ok = await this.musicCallbacks.playPlaylist(intent.playlistName || '', context);
        return {
          success: ok,
          message: ok ? `Playing playlist ${intent.playlistName}` : 'Playlist not found',
          action: 'playPlaylist',
        };
      }

      case 'SHOW_LYRICS': {
        const res = await this.musicCallbacks.showLyrics(context);
        return {
          success: res.success,
          message: res.success ? (res.lyrics ? 'Displaying lyrics' : 'No lyrics found') : 'Failed to fetch lyrics',
          action: 'showLyrics',
        };
      }

      case 'SAVE_FAVORITE': {
        const ok = await this.musicCallbacks.saveFavorite(context);
        return { success: ok, message: ok ? 'Track added to favorites' : 'Failed to favorite', action: 'saveFavorite' };
      }

      case 'SET_LOOP': {
        const mode = intent.loopMode || 'off';
        const ok = await this.musicCallbacks.setLoop(mode, context);
        return { success: ok, message: ok ? `Loop set to ${mode}` : 'Failed to set loop', action: 'setLoop' };
      }

      case 'CONVERSATIONAL_QUERY': {
        return {
          success: true,
          message: intent.conversationalResponse || 'How can I assist your listening session today?',
          action: 'conversationalQuery',
        };
      }

      default:
        return { success: false, message: 'Unrecognized intent' };
    }
  }

  /**
   * Resolves a pending ambiguity clarification query.
   */
  private async resolveClarification(
    transcript: string,
    context: VoiceCommandContext,
    startTime: number,
  ): Promise<VoiceCommandResult> {
    const { candidates } = this.pendingClarification!;
    this.pendingClarification = null;

    const trimmed = transcript.trim().toLowerCase();
    let chosenTrack = candidates[0];

    // Check if user specified a number (e.g. "number one", "1", "the second one", "2")
    const numMatch = trimmed.match(/(?:number\s+|#)?([1-9])/);
    if (numMatch) {
      const idx = parseInt(numMatch[1], 10) - 1;
      if (idx >= 0 && idx < candidates.length) {
        chosenTrack = candidates[idx];
      }
    } else {
      // Fuzzy title match
      const matched = candidates.find((c) =>
        trimmed.includes(c.title.toLowerCase()) || (c.artist && trimmed.includes(c.artist.toLowerCase())),
      );
      if (matched) chosenTrack = matched;
    }

    if (this.musicCallbacks) {
      const res = await this.musicCallbacks.playTrack(chosenTrack.title, context);
      return {
        success: res.success,
        intent: 'PLAY_TRACK',
        message: `Playing ${chosenTrack.title}${chosenTrack.artist ? ` by ${chosenTrack.artist}` : ''}`,
        executedAction: 'playTrack',
        latencyMs: Date.now() - startTime,
        provider: 'local_deterministic',
      };
    }

    return {
      success: false,
      intent: 'PLAY_TRACK',
      message: 'Failed to play selected track',
      latencyMs: Date.now() - startTime,
      provider: 'local_deterministic',
    };
  }
}
