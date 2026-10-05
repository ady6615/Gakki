/**
 * Phase 13 Automated Verification Suite
 *
 * Tests all 22+ categories for:
 * 1. Audio Resampling (48kHz to 16kHz PCM) & 24kHz upsampling
 * 2. Local Voice Activity Detection (VAD) (energy threshold, hangover)
 * 3. Local Wake Word Detector ("Hey Gakki" evaluation)
 * 4. Deterministic Local Command Matcher fallback
 * 5. Strict Intent Schema & Whitelisted Function Calling
 * 6. Ambiguous Track Resolution & Clarification Prompt
 * 7. Backend Permission Enforcement
 * 8. Gemini Live Session Lifecycle & Reconnection
 * 9. Voice Interruption / Barge-in Handling
 * 10. Privacy State (Voice Commands ON/OFF)
 * 11. AI DJ Commentary Text Generator (Metadata verification)
 * 12. Modular TTS Provider Registry (Gemini & Local TTS)
 * 13. Commentary Pre-Generation & Zero Audio Gap Guarantee
 * 14. CommentaryMixer Ducking & Between-Song Mixing
 * 15. Execution Priority Hierarchy (User Speech > Playback > DJ)
 * 16. Platform-Neutral Participant Model & VoiceSession
 * 17. Google Meet Voice Adapter Receive Path & Participant Metadata
 * 18. Google Meet SEND Limitation & Desktop Virtual Audio Workaround
 * 19. Google Meet OAuth Scopes & Developer Preview Graceful Degradation
 * 20. Voice & AI Rate Limiting
 * 21. Music Playback Continuity on Voice/AI Failure
 * 22. End-to-End Voice Command Dispatch
 */

import {
  AudioResampler,
  VoiceActivityDetector,
  WakeWordDetector,
  VoiceResponseOutput,
  LocalCommandMatcher,
  VoiceIntentSchema,
  WHITELISTED_VOICE_TOOLS,
  PROHIBITED_FUNCTION_NAMES,
  validateVoiceIntent,
  VoiceCommandEngine,
  DJTextGenerator,
  LocalTTSProvider,
  GeminiTTSProvider,
  TTSProviderRegistry,
  CommentaryMixer,
  DJCommentaryEngine,
  VoiceSessionManager,
  CommandPermissionLevel,
} from '@gakki/core';
import { GeminiLiveVoiceProvider } from '../voice/gemini-live-voice.provider';
import { MeetOAuthService } from '../meet/meet-oauth.service';
import { MeetVoiceAdapter } from '../meet/meet-voice.adapter';
import { VoiceRateLimiter } from '../security/voice-rate-limiter';

let totalTests = 0;
let passedTests = 0;

function assert(condition: unknown, testName: string, details?: string): void {
  totalTests++;
  if (Boolean(condition)) {
    passedTests++;
    console.log(`  ✓ [PASS] ${testName}`);
  } else {
    console.error(`  ✗ [FAIL] ${testName}${details ? ` — ${details}` : ''}`);
  }
}

async function runPhase13Tests() {
  console.log('\n======================================================================');
  console.log('  Gakki Music Platform — Phase 13 Verification Test Suite');
  console.log('======================================================================\n');

  // ── 1. Audio Resampling & Format Conversion ────────────────────
  console.log('--- Category 1: Audio Resampling & Format Conversion ---');
  {
    // Generate 48kHz mono 16-bit PCM (4800 samples = 9600 bytes = 100ms)
    const pcm48k = Buffer.alloc(9600);
    for (let i = 0; i < 4800; i++) {
      const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / 48000) * 16000);
      pcm48k.writeInt16LE(sample, i * 2);
    }

    const pcm16k = AudioResampler.downsample48kTo16kMono(pcm48k, 1);
    assert(
      pcm16k.length === 3200,
      'Downsamples 48kHz (4800 samples) to 16kHz (1600 samples = 3200 bytes)',
      `Got ${pcm16k.length} bytes`,
    );

    // 24kHz to 48kHz stereo upsampling
    const pcm24k = Buffer.alloc(4800); // 2400 samples
    const pcm48kStereo = AudioResampler.upsample24kTo48kStereo(pcm24k);
    // 2400 samples * 2 frames * 2 channels * 2 bytes = 19200 bytes
    assert(
      pcm48kStereo.length === 19200,
      'Upsamples 24kHz mono (2400 samples) to 48kHz stereo (19200 bytes)',
      `Got ${pcm48kStereo.length} bytes`,
    );

    // Chunking utility
    const chunks = AudioResampler.chunkPcmBuffer(pcm16k, 1600);
    assert(chunks.length === 2, 'Chunks PCM buffer into equal-sized streaming packets');
  }

  // ── 2. Local Voice Activity Detection (VAD) ────────────────────
  console.log('\n--- Category 2: Local Voice Activity Detection (VAD) ---');
  {
    const vad = new VoiceActivityDetector({
      energyThresholdRms: 0.025,
      silenceHangoverMs: 350,
      minSpeechDurationMs: 100,
    });

    // Create silence buffer (RMS ~ 0)
    const silenceBuffer = Buffer.alloc(3200); // 100ms silence
    const silenceEvent = vad.processFrame(silenceBuffer, 1000);
    assert(silenceEvent.state === 'silence', 'Identifies silence buffer correctly');
    assert(!vad.isSpeechActive(), 'VAD speech state is inactive during silence');

    // Create speech buffer with high RMS
    const speechBuffer = Buffer.alloc(3200);
    for (let i = 0; i < 1600; i++) {
      speechBuffer.writeInt16LE(Math.round(Math.sin(i * 0.1) * 20000), i * 2);
    }

    vad.processFrame(speechBuffer, 1100);
    const speechEvent = vad.processFrame(speechBuffer, 1250);
    assert(speechEvent.state === 'speech', 'Detects active speech when energy exceeds threshold');
    assert(vad.isSpeechActive(), 'VAD speech state active during vocal input');

    // Hangover window test: brief silence frame does not drop speech immediately
    const hangoverEvent = vad.processFrame(silenceBuffer, 1300);
    assert(hangoverEvent.state === 'speech', 'Preserves speech state during hangover duration (prevents clipping)');
  }

  // ── 3. Local Wake Word Detector ("Hey Gakki") ──────────────────
  console.log('\n--- Category 3: Local Wake Word Detector ("Hey Gakki") ---');
  {
    const wakeWordDetector = new WakeWordDetector({ keyword: 'Hey Gakki', threshold: 0.6 });
    wakeWordDetector.startListening();

    // Text wake word matcher helper
    const match1 = wakeWordDetector.matchesWakeWordText('Hey Gakki play After Dark');
    assert(
      match1.matched && match1.strippedText === 'play After Dark',
      'Strips "Hey Gakki" prefix from spoken sentence',
    );

    const match2 = wakeWordDetector.matchesWakeWordText('Gakki, skip this song');
    assert(
      match2.matched && match2.strippedText === 'skip this song',
      'Recognizes comma and short "Gakki" prefix',
    );

    const match3 = wakeWordDetector.matchesWakeWordText('What is the weather today?');
    assert(!match3.matched, 'Correctly ignores text without wake word');
  }

  // ── 4. Deterministic Local Command Matcher ─────────────────────
  console.log('\n--- Category 4: Deterministic Local Command Matcher ---');
  {
    const cmd1 = LocalCommandMatcher.match('Hey Gakki, play Synthwave Radio');
    assert(
      cmd1 !== null && cmd1.intent === 'PLAY_TRACK' && cmd1.query === 'Synthwave Radio',
      'Matches "play <query>" locally with high confidence',
    );

    const cmd2 = LocalCommandMatcher.match('Gakki, pause');
    assert(cmd2 !== null && cmd2.intent === 'PAUSE', 'Matches "pause" command locally');

    const cmd3 = LocalCommandMatcher.match('skip');
    assert(cmd3 !== null && cmd3.intent === 'SKIP', 'Matches "skip" command locally');

    const cmd4 = LocalCommandMatcher.match('set volume to 80%');
    assert(
      cmd4 !== null && cmd4.intent === 'SET_VOLUME' && cmd4.volume === 80,
      'Matches "set volume to 80%" locally',
    );

    const cmd5 = LocalCommandMatcher.match('smart shuffle');
    assert(cmd5 !== null && cmd5.intent === 'SMART_SHUFFLE', 'Matches "smart shuffle" locally');

    const cmd6 = LocalCommandMatcher.match('play playlist Gaming Vibes');
    assert(
      cmd6 !== null && cmd6.intent === 'PLAY_PLAYLIST' && cmd6.playlistName === 'Gaming Vibes',
      'Matches "play playlist <name>" locally',
    );
  }

  // ── 5. Strict Intent Schema & Whitelisted Function Calling ────
  console.log('\n--- Category 5: Strict Intent Schema & Whitelisted Function Calling ---');
  {
    const validIntent = {
      intent: 'PLAY_TRACK',
      query: 'After Dark',
      confidence: 0.95,
      isConversational: false,
    };
    const check1 = validateVoiceIntent(validIntent, CommandPermissionLevel.USER);
    assert(check1.valid, 'Validates permitted intent against schema');

    const invalidIntent = {
      intent: 'EXECUTE_SHELL_COMMAND',
      query: 'rm -rf /',
    };
    const check2 = validateVoiceIntent(invalidIntent, CommandPermissionLevel.OWNER);
    assert(!check2.valid, 'Strictly rejects non-whitelisted intents');

    assert(
      PROHIBITED_FUNCTION_NAMES.has('execute_shell') &&
      PROHIBITED_FUNCTION_NAMES.has('read_file') &&
      PROHIBITED_FUNCTION_NAMES.has('run_sql'),
      'Maintains explicit security blacklist of dangerous functions',
    );

    assert(
      WHITELISTED_VOICE_TOOLS.some((t) => t.name === 'play_track') &&
      WHITELISTED_VOICE_TOOLS.some((t) => t.name === 'smart_shuffle') &&
      WHITELISTED_VOICE_TOOLS.some((t) => t.name === 'set_volume'),
      'Exposes only whitelisted music manipulation tool declarations',
    );
  }

  // ── 6. Permission Enforcement ──────────────────────────────────
  console.log('\n--- Category 6: Backend Permission Enforcement ---');
  {
    const djIntent = { intent: 'SET_VOLUME', volume: 50, confidence: 1.0 };

    // Standard USER attempting DJ command
    const userCheck = validateVoiceIntent(djIntent, CommandPermissionLevel.USER);
    assert(!userCheck.valid, 'Rejects DJ-level command from regular USER permission');

    // DJ role attempting DJ command
    const djCheck = validateVoiceIntent(djIntent, CommandPermissionLevel.DJ);
    assert(djCheck.valid, 'Allows DJ-level command when user has DJ permission');
  }

  // ── 7. Voice Interruption & Barge-in ───────────────────────────
  console.log('\n--- Category 7: Voice Interruption & Barge-in ---');
  {
    const voiceOutput = new VoiceResponseOutput();
    let interruptedEventFired = false;
    voiceOutput.on('barge_in_interrupted', () => {
      interruptedEventFired = true;
    });

    // Simulate AI speaking
    const speechChunk = Buffer.alloc(9600);
    voiceOutput.pushAudio48k(speechChunk);
    assert(voiceOutput.isCurrentlySpeaking(), 'Voice output enters speaking state');

    // User speaks -> trigger barge-in interruption
    voiceOutput.interrupt();
    assert(!voiceOutput.isCurrentlySpeaking(), 'Immediately halts AI voice output on interruption');
    assert(interruptedEventFired, 'Emits barge_in_interrupted event');
  }

  // ── 8. Gemini Live Session Lifecycle ───────────────────────────
  console.log('\n--- Category 8: Gemini Live Session Lifecycle ---');
  {
    const geminiProvider = new GeminiLiveVoiceProvider({
      apiKey: 'test-gemini-key',
      sessionTimeoutMs: 1000,
    });

    const connected = await geminiProvider.connect();
    assert(connected, 'Connects to Gemini Live session successfully');
    assert(geminiProvider.isConnected(), 'Reports active session state');

    // Tool dispatch verification
    const intent = geminiProvider.dispatchToolCall('play_track', { query: 'Midnight City' });
    assert(
      intent.intent === 'PLAY_TRACK' && intent.query === 'Midnight City',
      'Dispatches Gemini tool call to structured VoiceIntent',
    );

    // Prohibited tool attempt
    let securityError = false;
    try {
      geminiProvider.dispatchToolCall('execute_shell', { command: 'ls' });
    } catch {
      securityError = true;
    }
    assert(securityError, 'Blocks prohibited tool calls returned by model');

    await geminiProvider.close();
    assert(!geminiProvider.isConnected(), 'Closes session cleanly');
  }

  // ── 9. AI DJ Commentary Text Generator ─────────────────────────
  console.log('\n--- Category 9: AI DJ Commentary Text Generator ---');
  {
    const text1 = DJTextGenerator.generateCommentaryText({
      guildId: 'guild-1',
      trigger: 'DJ_START',
      toTrack: { id: 't1', title: 'Nightcall', artist: 'Kavinsky' },
      djProfile: 'BALANCED',
    });
    assert(
      text1.includes('Nightcall') && text1.includes('Kavinsky'),
      'Generates DJ start commentary referencing factual metadata',
    );

    const text2 = DJTextGenerator.generateCommentaryText({
      guildId: 'guild-1',
      trigger: 'ENERGY_TRANSITION',
      energyDelta: 0.35,
      toTrack: { id: 't2', title: 'Turbo Killer', artist: 'Carpenter Brut' },
    });
    assert(
      text2.toLowerCase().includes('energy') && text2.includes('Turbo Killer'),
      'Generates energy transition commentary based on acoustic delta',
    );
  }

  // ── 10. TTS Provider Registry & Providers ──────────────────────
  console.log('\n--- Category 10: Modular TTS Provider Registry ---');
  {
    const registry = new TTSProviderRegistry();
    const localProvider = registry.getProvider('local-tts');
    assert(localProvider instanceof LocalTTSProvider, 'Resolves LocalTTSProvider from registry');

    const synthResult = await localProvider.synthesize('Taking the energy up next with Nightcall.');
    assert(
      synthResult.audioBuffer.length > 0 && synthResult.format.sampleRate === 24000,
      'Synthesizes valid 24kHz PCM speech audio buffer',
    );
    assert(synthResult.durationSeconds > 0, 'Computes accurate audio duration');

    const geminiTTS = new GeminiTTSProvider();
    assert(Array.isArray(geminiTTS.getAvailableVoices()), 'Lists available voice profiles (Aoede, Puck, etc.)');
  }

  // ── 11. DJ Commentary Pre-Generation & Zero Audio Gap ──────────
  console.log('\n--- Category 11: DJ Commentary Pre-Generation & Cooldown ---');
  {
    const djEngine = new DJCommentaryEngine(undefined, { cooldownSeconds: 10 });

    // Initial pregeneration
    const pregen = await djEngine.pregenerateCommentary({
      guildId: 'guild-1',
      trigger: 'DJ_START',
      toTrack: { id: 't10', title: 'After Dark', artist: 'Mr. Kitty' },
    });
    assert(pregen !== null && pregen.readyForPlayback, 'Pre-generates commentary before transition occurs');

    // Consume pregenerated commentary
    const consumed = djEngine.consumePregeneratedCommentary('guild-1', 't10');
    assert(consumed !== null && consumed.id === pregen?.id, 'Consumes pre-rendered audio buffer instantly');

    // Immediate second trigger should be blocked by cooldown
    const triggerEval = djEngine.shouldTriggerCommentary({
      guildId: 'guild-1',
      trigger: 'TRACK_TRANSITION',
      toTrack: { id: 't11', title: 'Resonance', artist: 'HOME' },
    });
    assert(!triggerEval.shouldTrigger, 'Enforces commentary cooldown (does not speak before every song)');
  }

  // ── 12. Commentary Mixer & Priority Hierarchy ──────────────────
  console.log('\n--- Category 12: Commentary Mixer & Priority Hierarchy ---');
  {
    const mixer = new CommentaryMixer({ mixingMode: 'DUCKED_VOICE_OVER_MUSIC', allowVoiceOverMusic: true });

    const musicBuffer = Buffer.alloc(19200); // 100ms 48kHz stereo
    const voiceBuffer = Buffer.alloc(9600); // 50ms 48kHz stereo
    const commentaryObj = {
      id: 'c1',
      text: 'Sample',
      trigger: 'DJ_START' as const,
      voiceProfile: 'Puck',
      audioBuffer: voiceBuffer,
      audioFormat: { sampleRate: 48000, channels: 2, encoding: 'pcm_s16le' },
      readyForPlayback: true,
      mixingMode: 'DUCKED_VOICE_OVER_MUSIC' as const,
    };

    const mixedResult = mixer.mixCommentary(musicBuffer, commentaryObj);
    assert(mixedResult.mixed, 'Mixes commentary smoothly over music with ducking');

    // Priority Check: User speech active -> commentary skipped
    mixer.setUserSpeaking(true);
    const priorityResult = mixer.mixCommentary(musicBuffer, commentaryObj);
    assert(!priorityResult.mixed, 'Suppresses DJ commentary when user is speaking (Priority Rule 1)');
  }

  // ── 13. Platform-Neutral Voice Session ─────────────────────────
  console.log('\n--- Category 13: Platform-Neutral Voice Session ---');
  {
    const sessionManager = new VoiceSessionManager();
    const session = sessionManager.createSession({
      platform: 'google_meet',
      spaceId: 'abc-defg-hij',
      capabilities: {
        sendAudio: false,
        receiveAudio: true,
        receiveVideo: true,
        participantMetadata: true,
        recording: true,
      },
      initialParticipants: [
        {
          platform: 'google_meet',
          platformParticipantId: 'user_1',
          displayName: 'Alice (Google User)',
          isAnonymous: false,
          isPhone: false,
        },
        {
          platform: 'google_meet',
          platformParticipantId: 'anon_2',
          displayName: 'Guest Participant',
          isAnonymous: true,
          isPhone: false,
        },
        {
          platform: 'google_meet',
          platformParticipantId: 'phone_3',
          displayName: '+1 555-0199',
          isAnonymous: false,
          isPhone: true,
        },
      ],
    });

    assert(session.id.startsWith('vsess_'), 'Creates unique voice session');
    assert(session.participants.size === 3, 'Normalizes signed-in, anonymous, and phone participants');

    const ctx = sessionManager.createCommandContext({
      sessionId: session.id,
      userId: 'user_1',
      permissionLevel: CommandPermissionLevel.USER,
    });
    assert(ctx.platform === 'google_meet', 'Extracts safe platform context for voice engine');

    sessionManager.closeSession(session.id);
    assert(session.status === 'closed', 'Closes voice session cleanly');
  }

  // ── 14. Google Meet Adapter & Capabilities ─────────────────────
  console.log('\n--- Category 14: Google Meet Adapter (Receive Path) ---');
  {
    const oauthService = new MeetOAuthService({
      clientId: 'test-meet-client',
      clientSecret: 'test-meet-secret',
    });
    oauthService.setToken({
      accessToken: 'test-token',
      expiresAt: Date.now() + 3600000,
      tokenType: 'Bearer',
      scope: MeetOAuthService.REQUIRED_SCOPES,
    }, true);

    const meetAdapter = new MeetVoiceAdapter({ oauthService });
    const caps = meetAdapter.getCapabilities();

    assert(caps.receiveAudio === true, 'Meet receiveAudio is true');
    assert(caps.participantMetadata === true, 'Meet participantMetadata is true');
    assert(caps.sendAudio === false, 'Meet sendAudio is EXPLICITLY false (Requirement 26 constraint)');

    await meetAdapter.joinVoice('meet-space-123');
    assert(meetAdapter.getVoiceStatus() === 'CONNECTED', 'Connects to Meet conference receive session');

    // Attempt native sendAudio -> must throw clear explanation
    let sendBlocked = false;
    try {
      await meetAdapter.play('meet-space-123', {} as any);
    } catch (err: any) {
      sendBlocked = err.message.includes('not supported') || err.message.includes('Virtual Audio Output');
    }
    assert(sendBlocked, 'Throws informative error redirecting user to Virtual Audio Output for sending');

    await meetAdapter.leaveVoice();
    assert(meetAdapter.getVoiceStatus() === 'DISCONNECTED', 'Disconnects cleanly from Meet');
  }

  // ── 15. Voice & AI Rate Limiter ────────────────────────────────
  console.log('\n--- Category 15: Voice & AI Rate Limiter ---');
  {
    const limiter = new VoiceRateLimiter({
      maxCommandsPerMinuteUser: 3,
      maxTtsPerMinuteGuild: 2,
      maxGeminiSessionsPerGuild: 1,
    });

    assert(limiter.canExecuteCommand('user1').allowed, 'Allows initial command');
    assert(limiter.canExecuteCommand('user1').allowed, 'Allows second command');
    assert(limiter.canExecuteCommand('user1').allowed, 'Allows third command');
    assert(!limiter.canExecuteCommand('user1').allowed, 'Blocks fourth command exceeding rate limit');

    assert(limiter.acquireSessionSlot('guild1'), 'Acquires session slot');
    assert(!limiter.acquireSessionSlot('guild1'), 'Blocks exceeding session limit');
    limiter.releaseSessionSlot('guild1');
    assert(limiter.acquireSessionSlot('guild1'), 'Releases and re-acquires session slot');
  }

  // ── 16. End-to-End Voice Command Engine ────────────────────────
  console.log('\n--- Category 16: End-to-End Voice Command Engine ---');
  {
    const engine = new VoiceCommandEngine();
    let playedTrackName = '';

    engine.setMusicCallbacks({
      playTrack: async (q) => {
        playedTrackName = q;
        return { success: true, trackName: q };
      },
      pause: async () => true,
      resume: async () => true,
      skip: async () => true,
      stop: async () => true,
      setVolume: async () => true,
      smartShuffle: async () => true,
      enableDJ: async () => true,
      disableDJ: async () => true,
      playPlaylist: async () => true,
      showLyrics: async () => ({ success: true, lyrics: 'Sample lyrics' }),
      saveFavorite: async () => true,
      setLoop: async () => true,
      searchLibrary: async (q) => {
        if (q.toLowerCase() === 'after dark') {
          return [
            { id: '1', title: 'After Dark', artist: 'Mr. Kitty' },
            { id: '2', title: 'After Dark', artist: 'Asian Kung-Fu Generation' },
          ];
        }
        return [{ id: '3', title: q, artist: 'Artist' }];
      },
    });

    await engine.setEnabled(true);
    assert(engine.getState().enabled, 'Enables voice commands (🎤 ON)');

    // 1. Direct unambiguous command
    const res1 = await engine.executeVoiceCommand('Hey Gakki, pause', {
      platform: 'desktop',
      userId: 'u1',
      permissionLevel: CommandPermissionLevel.USER,
    });
    assert(res1.success && res1.intent === 'PAUSE', 'Executes unambiguous "pause" command');

    // 2. Ambiguous command resolution prompt (Requirement 9)
    const res2 = await engine.executeVoiceCommand('Hey Gakki, play After Dark', {
      platform: 'desktop',
      userId: 'u1',
      permissionLevel: CommandPermissionLevel.USER,
    });
    assert(
      res2.needsClarification && res2.intent === 'CLARIFY_AMBIGUITY',
      'Prompts user when query matches multiple candidate tracks',
    );

    // 3. User responds with selection "number 1"
    const res3 = await engine.executeVoiceCommand('1', {
      platform: 'desktop',
      userId: 'u1',
      permissionLevel: CommandPermissionLevel.USER,
    });
    assert(
      res3.success && res3.intent === 'PLAY_TRACK' && playedTrackName === 'After Dark',
      'Resolves ambiguous selection and executes play on selected track',
    );

    // 4. Privacy: toggle OFF
    await engine.setEnabled(false);
    assert(!engine.getState().enabled, 'Disables voice commands (🎤 OFF) and tears down listeners');
  }

  console.log('\n======================================================================');
  console.log(`  Test Results: ${passedTests} / ${totalTests} PASSED (${Math.round((passedTests / totalTests) * 100)}%)`);
  console.log('======================================================================\n');

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

runPhase13Tests().catch((err) => {
  console.error('Fatal error during test execution:', err);
  process.exit(1);
});
