import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  QueueManager,
  PlaybackManager,
  LocalAudioSource,
  VoicePlatformAdapter,
  VoicePlatformState,
  AudioTrackInfo,
  VoiceConnectionStatus,
  PlaybackStatus,
  AudioSource,
  createLogger,
} from '@gakki/core';
import {
  scanFolderForAudio,
  enqueueFolder,
  enqueueMultipleFiles,
  secureResolveMusicPath,
} from '../audio/batch-loader';
import {
  handleChatInputCommand,
  slashCommandDefinitions,
  formatDuration,
} from '../discord/commands';

const logger = createLogger('queue-test');

/**
 * Controllable Mock VoicePlatformAdapter for Queue & Advancement testing.
 */
class ControllableVoiceAdapter implements VoicePlatformAdapter {
  readonly platform = 'mock-discord';
  public voiceStatus: VoiceConnectionStatus = 'DISCONNECTED';
  public playerStatus: PlaybackStatus = 'IDLE';
  public currentTrack: AudioTrackInfo | null = null;
  public trackHistory: string[] = [];

  private stateListeners = new Set<(state: VoicePlatformState) => void>();
  private errorListeners = new Set<(guildId: string, err: Error) => void>();
  private trackEndListeners = new Set<(guildId: string) => void>();

  async joinVoice(guildId: string, channelId: string): Promise<void> {
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
    if (source.identifier.includes('broken') || (source as any).resolvedPath?.includes('broken')) {
      throw new Error('FFmpeg decoding failed: Invalid audio data');
    }
    await source.validate();
    const meta = await source.getMetadata();


    this.currentTrack = {
      name: meta.title,
      duration: meta.duration ?? null,
      artist: meta.artist ?? null,
      filePath: source.identifier,
      sourceType: source.sourceType,
    };
    this.trackHistory.push(meta.title);
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
    // When stopped by player/skip/stop, emit track end
    this.emitTrackEnd(guildId);
    return true;
  }

  /**
   * Simulate a track finishing naturally (without manual stop).
   */
  simulateTrackNaturalFinish(guildId: string): void {
    this.playerStatus = 'IDLE';
    this.currentTrack = null;
    this.emitState(guildId);
    this.emitTrackEnd(guildId);
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

  onTrackEnd(listener: (guildId: string) => void): void {
    this.trackEndListeners.add(listener);
  }

  private emitState(guildId: string): void {
    const s = this.getState(guildId);
    for (const l of this.stateListeners) l(s);
  }

  private emitTrackEnd(guildId: string): void {
    for (const l of this.trackEndListeners) l(guildId);
  }
}

/**
 * Mock interaction builder
 */
function createMockInteraction(options: {
  commandName: string;
  guildId?: string;
  inVoice?: boolean;
  fileOption?: string | null;
  filesOption?: string | null;
  folderOption?: string | null;
}) {
  let repliedText = '';
  let isDeferred = false;
  let isReplied = false;

  const mockChannel = options.inVoice !== false
    ? {
        id: 'voice-channel-1',
        name: 'Music Lounge',
        isVoiceBased: () => true,
        permissionsFor: () => ({ has: () => true }),
      }
    : null;

  return {
    commandName: options.commandName,
    guildId: options.guildId || 'guild-A',
    member: {
      displayName: 'TestUser',
      voice: { channel: mockChannel },
      user: { username: 'testuser' },
    },
    guild: {
      id: options.guildId || 'guild-A',
      members: { me: { id: 'bot-1' } },
    },
    options: {
      getString: (name: string) => {
        if (name === 'file') return options.fileOption ?? null;
        if (name === 'files') return options.filesOption ?? null;
        if (name === 'folder') return options.folderOption ?? null;
        return null;
      },
    },
    deferReply: async () => {
      isDeferred = true;
    },
    editReply: async (content: string) => {
      repliedText = content;
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

async function runPhase3Tests() {
  console.log('\n======================================================');
  console.log('   Gakki Music Platform — Phase 3 Test Suite');
  console.log('======================================================\n');

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

  // ────────────────────────────────────────────────────────────────
  // Test A — Single Queue & Auto-Advancement
  // ────────────────────────────────────────────────────────────────
  console.log('Test A: Single Queue & Auto-Advancement');
  const adapterA = new ControllableVoiceAdapter();
  adapterA.voiceStatus = 'CONNECTED';
  const queueMgrA = new QueueManager(logger);
  const playbackMgrA = new PlaybackManager(logger, queueMgrA);
  playbackMgrA.registerAdapter(adapterA);

  const sourceA = new LocalAudioSource('track_a.mp3');
  const sourceB = new LocalAudioSource('track_b.wav');
  const sourceC = new LocalAudioSource('track_c.ogg');

  // Play A -> starts immediately
  const playA = await playbackMgrA.play('guild-A', sourceA, { name: 'Track A', path: 'track_a.mp3' });
  assert(playA.status === 'started', '/play A starts playback immediately');
  assert(playbackMgrA.getCurrentTrack('guild-A')?.name === 'Track A', 'Current track is Track A');

  // Play B -> queued
  const playB = await playbackMgrA.play('guild-A', sourceB, { name: 'Track B', path: 'track_b.wav' });
  assert(playB.status === 'queued' && playB.position === 1, '/play B enqueues Track B at position 1');

  // Play C -> queued
  const playC = await playbackMgrA.play('guild-A', sourceC, { name: 'Track C', path: 'track_c.ogg' });
  assert(playC.status === 'queued' && playC.position === 2, '/play C enqueues Track C at position 2');

  assert(queueMgrA.getQueueLength('guild-A') === 2, 'Queue has 2 tracks (B, C)');

  // When A finishes naturally
  adapterA.simulateTrackNaturalFinish('guild-A');
  // Wait microtask
  await new Promise((r) => setTimeout(r, 50));

  assert(playbackMgrA.getCurrentTrack('guild-A')?.name === 'Track B', 'Track B auto-started when Track A finished');
  assert(queueMgrA.getQueueLength('guild-A') === 1, 'Queue now has 1 track (C)');

  // When B finishes naturally
  adapterA.simulateTrackNaturalFinish('guild-A');
  await new Promise((r) => setTimeout(r, 50));

  assert(playbackMgrA.getCurrentTrack('guild-A')?.name === 'Track C', 'Track C auto-started when Track B finished');
  assert(queueMgrA.isEmpty('guild-A'), 'Queue is empty after Track C starts');

  // When C finishes naturally
  adapterA.simulateTrackNaturalFinish('guild-A');
  await new Promise((r) => setTimeout(r, 50));

  assert(playbackMgrA.getCurrentTrack('guild-A') === null, 'Current track is null after queue exhausts');
  assert(adapterA.getPlaybackStatus('guild-A') === 'IDLE', 'Player is IDLE after final track');
  assert(adapterA.getVoiceStatus('guild-A') === 'CONNECTED', 'Voice connection remains CONNECTED (Test D)');

  // ────────────────────────────────────────────────────────────────
  // Test B — Multiple Guild Isolation
  // ────────────────────────────────────────────────────────────────
  console.log('\nTest B: Multiple Guilds Queue Isolation');
  const queueMgrB = new QueueManager(logger);
  const guildA_id = 'guild-alpha';
  const guildB_id = 'guild-beta';

  queueMgrB.addTrack(guildA_id, { name: 'A1', path: 'track_a.mp3' });
  queueMgrB.addTrack(guildA_id, { name: 'A2', path: 'track_b.wav' });

  queueMgrB.addTrack(guildB_id, { name: 'B1', path: 'track_c.ogg' });
  queueMgrB.addTrack(guildB_id, { name: 'B2', path: 'track_d.flac' });

  assert(queueMgrB.getQueueLength(guildA_id) === 2, 'Guild Alpha has 2 tracks');
  assert(queueMgrB.getQueueLength(guildB_id) === 2, 'Guild Beta has 2 tracks');

  const nextAlpha = queueMgrB.getNext(guildA_id);
  assert(nextAlpha?.name === 'A1', 'Guild Alpha dequeued A1');
  assert(queueMgrB.getQueueLength(guildA_id) === 1, 'Guild Alpha has 1 track remaining');
  assert(queueMgrB.getQueueLength(guildB_id) === 2, 'Guild Beta queue was NOT affected by Alpha dequeue');

  const nextBeta = queueMgrB.getNext(guildB_id);
  assert(nextBeta?.name === 'B1', 'Guild Beta dequeued B1');
  assert(queueMgrB.getQueueLength(guildB_id) === 1, 'Guild Beta has 1 track remaining');

  // ────────────────────────────────────────────────────────────────
  // Test C — Manual Skip (No Duplicate Idle Advancement)
  // ────────────────────────────────────────────────────────────────
  console.log('\nTest C: Manual Skip & Duplicate Idle Prevention');
  const adapterC = new ControllableVoiceAdapter();
  adapterC.voiceStatus = 'CONNECTED';
  const queueMgrC = new QueueManager(logger);
  const playbackMgrC = new PlaybackManager(logger, queueMgrC);
  playbackMgrC.registerAdapter(adapterC);

  await playbackMgrC.play('guild-C', new LocalAudioSource('track_a.mp3'), { name: 'A', path: 'track_a.mp3' });
  await playbackMgrC.play('guild-C', new LocalAudioSource('track_b.wav'), { name: 'B', path: 'track_b.wav' });
  await playbackMgrC.play('guild-C', new LocalAudioSource('track_c.ogg'), { name: 'C', path: 'track_c.ogg' });

  assert(playbackMgrC.getCurrentTrack('guild-C')?.name === 'A', 'Initially playing Track A');
  assert(queueMgrC.getQueueLength('guild-C') === 2, 'Queue has 2 tracks (B, C)');

  // Call skip on Track A
  const skipResult = await playbackMgrC.skip('guild-C');
  assert(skipResult.skipped === true, 'Track A skipped');
  assert(skipResult.nowPlaying?.name === 'B', 'Now playing Track B (not C)');
  assert(playbackMgrC.getCurrentTrack('guild-C')?.name === 'B', 'Current track is B');
  assert(queueMgrC.getQueueLength('guild-C') === 1, 'Queue has exactly 1 track remaining (C)');
  assert(queueMgrC.inspectQueue('guild-C')[0].name === 'C', 'Remaining queued track is C');

  // ────────────────────────────────────────────────────────────────
  // Test D — Empty Queue State
  // ────────────────────────────────────────────────────────────────
  console.log('\nTest D: Empty Queue Handling');
  // Skip track B -> now playing C
  await playbackMgrC.skip('guild-C');
  assert(playbackMgrC.getCurrentTrack('guild-C')?.name === 'C', 'Now playing Track C');
  assert(queueMgrC.isEmpty('guild-C'), 'Queue is now empty');

  // Skip track C -> no more tracks
  const finalSkip = await playbackMgrC.skip('guild-C');
  assert(finalSkip.skipped === true, 'Final track skipped');
  assert(finalSkip.nowPlaying === null, 'Now playing is null');
  assert(playbackMgrC.getCurrentTrack('guild-C') === null, 'Current track is null');
  assert(adapterC.getPlaybackStatus('guild-C') === 'IDLE', 'Player state is IDLE');
  assert(adapterC.getVoiceStatus('guild-C') === 'CONNECTED', 'Voice connection remains connected');

  // ────────────────────────────────────────────────────────────────
  // Test E — Folder Batch & Filename Ordering
  // ────────────────────────────────────────────────────────────────
  console.log('\nTest E: Folder Batch Enqueueing & Deterministic Ordering');
  const queueMgrE = new QueueManager(logger);
  const scanned = await scanFolderForAudio('my-playlist');
  assert(scanned.length === 3, 'Scanned exactly 3 audio files (ignored cover.txt)');
  assert(scanned[0].name === '01_intro', 'First file is 01_intro');
  assert(scanned[1].name === '02_theme', 'Second file is 02_theme');
  assert(scanned[2].name === '03_outro', 'Third file is 03_outro');

  const enqueuedFolder = await enqueueFolder('guild-E', 'my-playlist', queueMgrE, 'User1');
  assert(enqueuedFolder.length === 3, 'EnqueueFolder added 3 tracks to queue');
  assert(queueMgrE.getQueueLength('guild-E') === 3, 'Queue length is 3');

  const qItems = queueMgrE.inspectQueue('guild-E');
  assert(qItems[0].name === '01_intro', 'Queue item 1 is 01_intro');
  assert(qItems[1].name === '02_theme', 'Queue item 2 is 02_theme');
  assert(qItems[2].name === '03_outro', 'Queue item 3 is 03_outro');

  // ────────────────────────────────────────────────────────────────
  // Test F — Failed Track Recovery (No Crash)
  // ────────────────────────────────────────────────────────────────
  console.log('\nTest F: Broken Audio File Handling & Error Recovery');
  const adapterF = new ControllableVoiceAdapter();
  adapterF.voiceStatus = 'CONNECTED';
  const queueMgrF = new QueueManager(logger);
  const playbackMgrF = new PlaybackManager(logger, queueMgrF);
  playbackMgrF.registerAdapter(adapterF);

  // Play valid1, queue broken.mp3, queue valid2 (track_b.wav)
  await playbackMgrF.play('guild-F', new LocalAudioSource('track_a.mp3'), { name: 'Valid 1', path: 'track_a.mp3' });
  queueMgrF.addTrack('guild-F', { name: 'Broken Track', path: 'broken.mp3' });
  queueMgrF.addTrack('guild-F', { name: 'Valid 2', path: 'track_b.wav' });

  assert(playbackMgrF.getCurrentTrack('guild-F')?.name === 'Valid 1', 'Valid 1 is playing');
  assert(queueMgrF.getQueueLength('guild-F') === 2, 'Queue has 2 tracks (Broken, Valid 2)');

  // Valid 1 finishes naturally -> should hit broken.mp3, log error, and auto-advance to Valid 2!
  adapterF.simulateTrackNaturalFinish('guild-F');
  await new Promise((r) => setTimeout(r, 100));

  assert(
    playbackMgrF.getCurrentTrack('guild-F')?.name === 'Valid 2' ||
      playbackMgrF.getCurrentTrack('guild-F')?.name === 'track_b',
    'Auto-recovered from broken track and started Valid 2 without crashing',
  );
  assert(queueMgrF.isEmpty('guild-F'), 'Queue is empty after advancing to Valid 2');

  // ────────────────────────────────────────────────────────────────
  // Test G — Security & Path Traversal Prevention
  // ────────────────────────────────────────────────────────────────
  console.log('\nTest G: Security & Directory Traversal Protection');
  try {
    secureResolveMusicPath('../../secrets.env');
    assert(false, 'Should throw error on directory traversal');
  } catch (err: any) {
    assert(
      err.message.includes('outside the music storage directory'),
      'Directory traversal path (../../) was rejected with security error',
    );
  }

  // ────────────────────────────────────────────────────────────────
  // Test H — Multiple Files Enqueueing
  // ────────────────────────────────────────────────────────────────
  console.log('\nTest H: Multiple File Enqueueing in Order');
  const queueMgrH = new QueueManager(logger);
  const addedFiles = await enqueueMultipleFiles(
    'guild-H',
    ['track_a.mp3', 'track_b.wav', 'track_c.ogg', 'track_d.flac'],
    queueMgrH,
    'Tester',
  );
  assert(addedFiles.length === 4, 'Added 4 tracks via enqueueMultipleFiles');
  assert(queueMgrH.getQueueLength('guild-H') === 4, 'Guild H queue length is 4');
  assert(queueMgrH.inspectQueue('guild-H')[3].path === 'track_d.flac', '4th track is track_d.flac');

  // ────────────────────────────────────────────────────────────────
  // Test I — Discord Slash Commands (/queue, /addqueue, /play queueing)
  // ────────────────────────────────────────────────────────────────
  console.log('\nTest I: Discord Interaction Handlers for Phase 3');
  const adapterI = new ControllableVoiceAdapter();
  adapterI.voiceStatus = 'CONNECTED';
  const queueMgrI = new QueueManager(logger);
  const playbackMgrI = new PlaybackManager(logger, queueMgrI);
  playbackMgrI.registerAdapter(adapterI);

  // 1. /queue on empty
  const qInteraction1 = createMockInteraction({ commandName: 'queue', guildId: 'guild-I' });
  await handleChatInputCommand(qInteraction1 as any, playbackMgrI);
  assert(qInteraction1.getRepliedText().includes('The queue is empty'), '/queue reports empty queue cleanly');

  // 2. /play track_a -> starts
  const playInteraction1 = createMockInteraction({ commandName: 'play', guildId: 'guild-I', fileOption: 'track_a.mp3' });
  await handleChatInputCommand(playInteraction1 as any, playbackMgrI);
  assert(playInteraction1.getRepliedText().includes('Started:'), '/play starts immediately when idle');

  // 3. /play track_b while playing -> enqueued
  const playInteraction2 = createMockInteraction({ commandName: 'play', guildId: 'guild-I', fileOption: 'track_b.wav' });
  await handleChatInputCommand(playInteraction2 as any, playbackMgrI);
  assert(playInteraction2.getRepliedText().includes('Added to queue'), '/play queues track when already playing');
  assert(playInteraction2.getRepliedText().includes('Position: **1**'), '/play reports position 1');

  // 4. /addqueue folder
  const addQueueInteraction = createMockInteraction({
    commandName: 'addqueue',
    guildId: 'guild-I',
    folderOption: 'my-playlist',
  });
  await handleChatInputCommand(addQueueInteraction as any, playbackMgrI);
  assert(addQueueInteraction.getRepliedText().includes('Added **3** track(s)'), '/addqueue folder enqueues 3 tracks');
  assert(queueMgrI.getQueueLength('guild-I') === 4, 'Queue now has 4 tracks total (track_b + 3 from folder)');

  // 5. /queue with tracks
  const qInteraction2 = createMockInteraction({ commandName: 'queue', guildId: 'guild-I' });
  await handleChatInputCommand(qInteraction2 as any, playbackMgrI);
  const qText = qInteraction2.getRepliedText();
  assert(qText.includes('Now Playing'), '/queue displays Now Playing');
  assert(qText.includes('1. track_b'), '/queue displays track_b at position 1');
  assert(qText.includes('4 tracks queued'), '/queue reports 4 tracks queued');

  // 6. /skip
  const skipInteraction = createMockInteraction({ commandName: 'skip', guildId: 'guild-I' });
  await handleChatInputCommand(skipInteraction as any, playbackMgrI);
  assert(skipInteraction.getRepliedText().includes('Skipped track. Now playing: **track_b**'), '/skip advances to track_b');

  console.log(`\n======================================================`);
  console.log(`Phase 3 Test Suite Results: ${passed} passed, ${failed} failed`);
  console.log(`======================================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runPhase3Tests().catch((err) => {
  console.error('Phase 3 test suite failed:', err);
  process.exit(1);
});
