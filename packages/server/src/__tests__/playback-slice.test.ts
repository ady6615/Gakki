import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AudioPlayerManager,
  LocalAudioSource,
  VoicePlatformAdapter,
  VoicePlatformState,
  AudioTrackInfo,
  VoiceConnectionStatus,
  PlaybackStatus,
  AudioSource,
  VoicePermissionError,
  createLogger,
} from '@gakki/core';
import { probeAudioMetadata } from '../audio/ffmpeg';
import { listLocalAudioFiles } from '../audio/local-files';
import {
  handleChatInputCommand,
  slashCommandDefinitions,
  formatDuration,
} from '../discord/commands';

const logger = createLogger('test');

/**
 * Mock VoicePlatformAdapter to test all platform operations without
 * requiring an active Discord voice connection.
 */
class MockVoiceAdapter implements VoicePlatformAdapter {
  readonly platform = 'mock-discord';
  private voiceStatus: VoiceConnectionStatus = 'DISCONNECTED';
  private playerStatus: PlaybackStatus = 'IDLE';
  private currentTrack: AudioTrackInfo | null = null;
  private stateListeners: Set<(state: VoicePlatformState) => void> = new Set();
  private errorListeners: Set<(guildId: string, err: Error) => void> = new Set();

  async joinVoice(guildId: string, channelId: string, options?: any): Promise<void> {
    if (options?.shouldFailPermission) {
      this.voiceStatus = 'ERROR';
      this.emitState(guildId);
      throw new VoicePermissionError(['Connect', 'Speak']);
    }
    this.voiceStatus = 'CONNECTED';
    this.emitState(guildId);
  }

  async leaveVoice(guildId: string): Promise<void> {
    this.stop(guildId);
    this.voiceStatus = 'DISCONNECTED';
    this.emitState(guildId);
  }

  getVoiceStatus(guildId: string): VoiceConnectionStatus {
    return this.voiceStatus;
  }

  async play(guildId: string, source: AudioSource): Promise<void> {
    await source.validate();
    const meta = await source.getMetadata();
    this.currentTrack = {
      name: meta.title,
      duration: meta.duration ?? null,
      artist: meta.artist ?? null,
      filePath: source.identifier,
      sourceType: source.sourceType,
    };
    this.playerStatus = 'PLAYING';
    this.emitState(guildId);
  }

  pause(guildId: string): boolean {
    if (this.playerStatus === 'PLAYING') {
      this.playerStatus = 'PAUSED';
      this.emitState(guildId);
      return true;
    }
    return false;
  }

  resume(guildId: string): boolean {
    if (this.playerStatus === 'PAUSED') {
      this.playerStatus = 'PLAYING';
      this.emitState(guildId);
      return true;
    }
    return false;
  }

  stop(guildId: string): boolean {
    this.playerStatus = 'IDLE';
    this.currentTrack = null;
    this.emitState(guildId);
    return true;
  }

  getPlaybackStatus(guildId: string): PlaybackStatus {
    return this.playerStatus;
  }

  getCurrentTrack(guildId: string): AudioTrackInfo | null {
    return this.currentTrack;
  }

  getState(guildId: string): VoicePlatformState {
    return {
      guildId,
      voiceState: this.voiceStatus,
      playerState: this.playerStatus,
      track: this.currentTrack,
    };
  }

  onStateChange(listener: (state: VoicePlatformState) => void): void {
    this.stateListeners.add(listener);
  }

  onError(listener: (guildId: string, error: Error) => void): void {
    this.errorListeners.add(listener);
  }

  triggerError(guildId: string, error: Error): void {
    this.playerStatus = 'ERROR';
    this.emitState(guildId);
    for (const l of this.errorListeners) l(guildId, error);
  }

  private emitState(guildId: string): void {
    const s = this.getState(guildId);
    for (const l of this.stateListeners) l(s);
  }
}

/**
 * Mock Discord ChatInputCommandInteraction
 */
function createMockInteraction(options: {
  commandName: string;
  guildId?: string | null;
  channelName?: string;
  inVoice?: boolean;
  hasPermissions?: boolean;
  fileOption?: string | null;
}) {
  let repliedText = '';
  let isDeferred = false;
  let isReplied = false;

  const mockChannel = options.inVoice
    ? {
        id: 'voice-123',
        name: options.channelName || 'General Voice',
        isVoiceBased: () => true,
        permissionsFor: () => ({
          has: () => options.hasPermissions !== false,
        }),
      }
    : null;

  return {
    commandName: options.commandName,
    guildId: options.guildId !== undefined ? options.guildId : 'guild-123',
    member: {
      voice: {
        channel: mockChannel,
      },
    },
    guild: {
      id: options.guildId !== undefined ? options.guildId : 'guild-123',
      members: {
        me: {
          id: 'bot-123',
        },
      },
    },
    options: {
      getString: (name: string) => (name === 'file' ? options.fileOption : null),
    },
    deferReply: async () => {
      isDeferred = true;
    },
    editReply: async (content: any) => {
      repliedText = typeof content === 'string' ? content : content?.content || '';
      isReplied = true;
      return content;
    },
    reply: async (msg: any) => {
      repliedText = typeof msg === 'string' ? msg : msg.content;
      isReplied = true;
      return msg;
    },
    isRepliable: () => true,
    get replied() {
      return isReplied;
    },
    get deferred() {
      return isDeferred;
    },
    getRepliedText: () => repliedText,
  };
}

async function runTests() {
  console.log('\n=== Starting Gakki Phase 2 Test Suite ===\n');
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, name: string) {
    if (condition) {
      console.log(`  [PASS] ${name}`);
      passed++;
    } else {
      console.error(`  [FAIL] ${name}`);
      failed++;
    }
  }

  // ── 1. Slash Command Definitions ──
  console.log('Test Group 1: Slash Command Definitions');
  const commandNames = slashCommandDefinitions.map((c) => c.name);
  assert(commandNames.includes('join'), 'Slash commands include /join');
  assert(commandNames.includes('play'), 'Slash commands include /play');
  assert(commandNames.includes('pause'), 'Slash commands include /pause');
  assert(commandNames.includes('resume'), 'Slash commands include /resume');
  assert(commandNames.includes('skip'), 'Slash commands include /skip');
  assert(commandNames.includes('leave'), 'Slash commands include /leave');
  assert(commandNames.includes('nowplaying'), 'Slash commands include /nowplaying');

  // ── 2. Local Audio File & Probe ──
  console.log('\nTest Group 2: AudioSource & FFmpeg Probing');
  const testMp3 = path.resolve('storage/music/test.mp3');
  assert(fs.existsSync(testMp3), 'storage/music/test.mp3 exists');

  const files = await listLocalAudioFiles();
  assert(files.includes('test.mp3'), 'listLocalAudioFiles includes test.mp3');

  const localSource = new LocalAudioSource('test.mp3', undefined, probeAudioMetadata);
  await localSource.validate();
  assert(true, 'LocalAudioSource.validate() passes for test.mp3');

  const metadata = await localSource.getMetadata();
  assert(metadata.duration === 10, `Probed duration matches 10 seconds (got ${metadata.duration})`);
  assert(
    metadata.title.includes('Gakki Test') || metadata.title === 'test',
    `Probed title is correct (got "${metadata.title}")`,
  );

  // ── 3. File Validation Error Handling ──
  console.log('\nTest Group 3: File Error Handling');

  // Nonexistent file
  const nonexistent = new LocalAudioSource('nonexistent_track.mp3');
  try {
    await nonexistent.validate();
    assert(false, 'Nonexistent file should throw FileNotFoundError');
  } catch (err: any) {
    assert(err.name === 'FileNotFoundError', 'Correctly rejected nonexistent file');
  }

  // Unsupported file
  const invalidTxtPath = path.resolve('storage/music/unsupported_sample.txt');
  fs.writeFileSync(invalidTxtPath, 'Dummy text file');
  const unsupportedSource = new LocalAudioSource('unsupported_sample.txt');
  try {
    await unsupportedSource.validate();
    assert(false, 'Unsupported extension should throw UnsupportedAudioFormatError');
  } catch (err: any) {
    assert(
      err.name === 'UnsupportedAudioFormatError',
      'Correctly rejected unsupported format (.txt)',
    );
  } finally {
    if (fs.existsSync(invalidTxtPath)) fs.unlinkSync(invalidTxtPath);
  }

  // ── 4. Interaction Handlers & Error Scenarios ──
  console.log('\nTest Group 4: Command Interactions & Edge Cases');
  const mockAdapter = new MockVoiceAdapter();
  const playerManager = new AudioPlayerManager(logger);
  playerManager.registerAdapter(mockAdapter);

  // Scenario 4A: User not in voice channel executing /join
  const joinNotInVoice = createMockInteraction({
    commandName: 'join',
    inVoice: false,
  });
  await handleChatInputCommand(joinNotInVoice as any, playerManager);
  assert(
    joinNotInVoice.getRepliedText().includes('must be in a voice channel'),
    '/join rejected when user is not in a voice channel',
  );

  // Scenario 4B: Bot missing permissions in voice channel
  const joinNoPerms = createMockInteraction({
    commandName: 'join',
    inVoice: true,
    hasPermissions: false,
  });
  await handleChatInputCommand(joinNoPerms as any, playerManager);
  assert(
    joinNoPerms.getRepliedText().includes('do not have permission'),
    '/join rejected gracefully when bot lacks Connect/Speak permissions',
  );

  // Scenario 4C: User not in voice channel executing /play
  const playNotInVoice = createMockInteraction({
    commandName: 'play',
    inVoice: false,
    fileOption: 'test.mp3',
  });
  await handleChatInputCommand(playNotInVoice as any, playerManager);
  assert(
    playNotInVoice.getRepliedText().includes('must be in a voice channel'),
    '/play rejected when user not in voice and bot not connected',
  );

  // Scenario 4D: /play nonexistent file
  const playNonexistent = createMockInteraction({
    commandName: 'play',
    inVoice: true,
    hasPermissions: true,
    fileOption: 'ghost_file.mp3',
  });
  await handleChatInputCommand(playNonexistent as any, playerManager);
  assert(
    playNonexistent.getRepliedText().includes('File not found'),
    '/play rejected gracefully when file does not exist',
  );

  // Scenario 4E: Valid /join
  const validJoin = createMockInteraction({
    commandName: 'join',
    inVoice: true,
    hasPermissions: true,
  });
  await handleChatInputCommand(validJoin as any, playerManager);
  assert(
    validJoin.getRepliedText().includes('Joined voice channel'),
    '/join succeeds with valid channel and permissions',
  );
  assert(playerManager.getState('guild-123').voiceState === 'CONNECTED', 'Voice state is CONNECTED');

  // Scenario 4F: Valid /play
  const validPlay = createMockInteraction({
    commandName: 'play',
    inVoice: true,
    hasPermissions: true,
    fileOption: 'test.mp3',
  });
  await handleChatInputCommand(validPlay as any, playerManager);
  assert(
    validPlay.getRepliedText().includes('Now playing') || validPlay.getRepliedText().includes('Started'),
    '/play starts playback and replies with track details',
  );
  assert(playerManager.getState('guild-123').playerState === 'PLAYING', 'Player state is PLAYING');
  assert(
    playerManager.getState('guild-123').track?.name !== undefined,
    'Current track metadata is populated',
  );

  // Scenario 4G: /nowplaying
  const npInteraction = createMockInteraction({
    commandName: 'nowplaying',
  });
  await handleChatInputCommand(npInteraction as any, playerManager);
  assert(
    npInteraction.getRepliedText().includes('Now Playing') &&
      npInteraction.getRepliedText().includes('PLAYING'),
    '/nowplaying reports track name and PLAYING status',
  );

  // Scenario 4H: /pause
  const pauseInteraction = createMockInteraction({
    commandName: 'pause',
  });
  await handleChatInputCommand(pauseInteraction as any, playerManager);
  assert(
    pauseInteraction.getRepliedText().includes('Playback paused'),
    '/pause pauses current playback',
  );
  assert(playerManager.getState('guild-123').playerState === 'PAUSED', 'Player state is PAUSED');

  // Scenario 4I: /resume
  const resumeInteraction = createMockInteraction({
    commandName: 'resume',
  });
  await handleChatInputCommand(resumeInteraction as any, playerManager);
  assert(
    resumeInteraction.getRepliedText().includes('Playback resumed'),
    '/resume resumes current playback',
  );
  assert(playerManager.getState('guild-123').playerState === 'PLAYING', 'Player state is PLAYING');

  // Scenario 4J: /skip
  const skipInteraction = createMockInteraction({
    commandName: 'skip',
  });
  await handleChatInputCommand(skipInteraction as any, playerManager);
  assert(
    skipInteraction.getRepliedText().includes('Skipped track') || skipInteraction.getRepliedText().includes('Track skipped'),
    '/skip stops the current track',
  );

  assert(playerManager.getState('guild-123').playerState === 'IDLE', 'Player state is IDLE after skip');

  // Scenario 4K: Bot leaving while audio is playing
  // Start playing again first
  await handleChatInputCommand(validPlay as any, playerManager);
  assert(playerManager.getState('guild-123').playerState === 'PLAYING', 'Resumed playing before leave');

  const leaveInteraction = createMockInteraction({
    commandName: 'leave',
  });
  await handleChatInputCommand(leaveInteraction as any, playerManager);
  assert(
    leaveInteraction.getRepliedText().includes('Disconnected from voice channel'),
    '/leave cleanly disconnects while audio was playing',
  );
  assert(
    playerManager.getState('guild-123').voiceState === 'DISCONNECTED',
    'Voice state is DISCONNECTED after leave',
  );
  assert(
    playerManager.getState('guild-123').playerState === 'IDLE',
    'Player state is IDLE after leave',
  );

  // Scenario 4L: Playback error handling
  // Connect and trigger an unexpected error
  await mockAdapter.joinVoice('guild-123', 'voice-123');
  mockAdapter.triggerError('guild-123', new Error('Simulated decoder failure'));
  assert(
    playerManager.getState('guild-123').playerState === 'ERROR',
    'Player state transitions to ERROR on unhandled playback error',
  );

  // ── 5. Duration Formatter ──
  console.log('\nTest Group 5: Duration Formatter');
  assert(formatDuration(0) === '0:00', '0s formatted as 0:00');
  assert(formatDuration(10) === '0:10', '10s formatted as 0:10');
  assert(formatDuration(75) === '1:15', '75s formatted as 1:15');
  assert(formatDuration(null) === 'Unknown', 'null formatted as Unknown');

  console.log(`\n========================================`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`========================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test suite failed with unhandled error:', err);
  process.exit(1);
});
