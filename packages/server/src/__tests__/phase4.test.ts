import {
  QueueManager,
  PlaybackManager,
  VoicePlatformAdapter,
  VoicePlatformState,
  AudioTrackInfo,
  VoiceConnectionStatus,
  PlaybackStatus,
  AudioSource,
  AudioFilterConfig,
  AdapterPlayOptions,
  LoopMode,
  createLogger,
} from '@gakki/core';
import {
  buildAudioFilterArgs,
  buildAtempoFilterChain,
  calculateEffectiveSpeed,
  clampVolume,
} from '../audio/audio-filters';
import { handleChatInputCommand } from '../discord/commands';

const logger = createLogger('phase4-test');

class MockAudioSource implements AudioSource {
  readonly sourceType = 'local';
  constructor(public identifier: string) {}
  async validate(): Promise<void> {}
  async getStream(): Promise<any> {
    return null;
  }
  async getMetadata() {
    return { title: this.identifier, duration: 180 };
  }
}

/**
 * Controllable Mock VoicePlatformAdapter for Phase 4 Voice Lifecycle & Effects testing.
 */
class Phase4MockAdapter implements VoicePlatformAdapter {
  readonly platform = 'mock-discord';
  public voiceStatus: VoiceConnectionStatus = 'DISCONNECTED';
  public playerStatus: PlaybackStatus = 'IDLE';
  public currentTrack: AudioTrackInfo | null = null;
  public volume: number = 100;
  public activeFilters: AudioFilterConfig = { bassboost: false, speed: 1.0, nightcore: false };
  public rebuildCount: number = 0;
  public lastRebuildSeek: number = 0;
  public humanCount: number = 1;
  public durationElapsedMs: number = 15000;

  private stateListeners = new Set<(state: VoicePlatformState) => void>();
  private errorListeners = new Set<(guildId: string, err: Error) => void>();
  private trackEndListeners = new Set<(guildId: string) => void>();

  async joinVoice(guildId: string, _channelId: string): Promise<void> {
    this.voiceStatus = 'CONNECTED';
    this.emitState(guildId);
  }

  async leaveVoice(guildId: string): Promise<void> {
    this.stop(guildId);
    this.voiceStatus = 'DISCONNECTED';
    this.emitState(guildId);
  }

  getVoiceStatus(_guildId: string): VoiceConnectionStatus {
    return this.voiceStatus;
  }

  async play(guildId: string, source: AudioSource, options?: AdapterPlayOptions): Promise<void> {
    this.playerStatus = 'PLAYING';
    this.currentTrack = {
      name: source.identifier,
      duration: 180,
      sourceType: source.sourceType,
      filePath: source.identifier,
    };
    if (options?.volume !== undefined) this.volume = options.volume;
    if (options?.filters) this.activeFilters = options.filters;
    this.emitState(guildId);
  }

  setVolume(_guildId: string, volume: number): void {
    this.volume = volume;
  }

  async rebuildCurrentStream(
    _guildId: string,
    filters: AudioFilterConfig,
    seekSeconds?: number,
  ): Promise<void> {
    this.rebuildCount++;
    this.activeFilters = filters;
    this.lastRebuildSeek = seekSeconds ?? Math.floor(this.durationElapsedMs / 1000);
  }

  getPlaybackDuration(_guildId: string): number {
    return this.durationElapsedMs;
  }

  getHumanCount(_guildId: string): number {
    return this.humanCount;
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

  getPlaybackStatus(_guildId: string): PlaybackStatus {
    return this.playerStatus;
  }

  getCurrentTrack(_guildId: string): AudioTrackInfo | null {
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

  triggerTrackEnd(guildId: string): void {
    this.playerStatus = 'IDLE';
    this.currentTrack = null;
    for (const listener of this.trackEndListeners) {
      listener(guildId);
    }
  }

  private emitState(guildId: string): void {
    const s = this.getState(guildId);
    for (const listener of this.stateListeners) {
      listener(s);
    }
  }
}

function createMockInteraction(commandName: string, guildId: string, options: Record<string, any> = {}) {
  let replyContent: string | null = null;
  let isDeferred = false;
  let deferredReplyContent: string | null = null;

  return {
    commandName,
    guildId,
    member: { displayName: 'Tester', voice: { channel: { id: 'voice-1', name: 'Voice 1', permissionsFor: () => ({ has: () => true }) } } },
    guild: { members: { me: { voice: { channelId: 'voice-1' }, permissionsFor: () => ({ has: () => true }) } } },
    options: {
      getInteger: (name: string) => options[name] ?? null,
      getString: (name: string) => options[name] ?? null,
      getNumber: (name: string) => options[name] ?? null,
      getFocused: () => ({ name: '', value: '' }),
    },
    deferReply: async () => { isDeferred = true; },
    reply: async (msg: any) => {
      replyContent = typeof msg === 'string' ? msg : msg.content;
    },
    editReply: async (msg: any) => {
      deferredReplyContent = typeof msg === 'string' ? msg : msg.content;
    },
    isRepliable: () => true,
    isAutocomplete: () => false,
    isChatInputCommand: () => true,
    get responseText() {
      return deferredReplyContent || replyContent;
    },
    get isDeferred() {
      return isDeferred;
    },
  };
}

let passed = 0;
let failed = 0;

function assert(condition: unknown, name: string) {
  if (Boolean(condition)) {
    passed++;
    console.log(`  [PASS] ${name}`);
  } else {
    failed++;
    console.error(`  [FAIL] ${name}`);
  }
}

async function runPhase4Tests() {
  console.log('\n======================================================');
  console.log('   Starting Gakki Phase 4 Test Suite');
  console.log('======================================================\n');

  const queueManager = new QueueManager(logger);

  // ─────────────────────────────────────────────────────────────
  // 1. Voice Lifecycle: Test A (Human remains in channel)
  // ─────────────────────────────────────────────────────────────
  console.log('Test 1: Voice Lifecycle - Human Remains (Test A)');
  {
    const adapter = new Phase4MockAdapter();
    adapter.humanCount = 2;
    const pm = new PlaybackManager(logger, queueManager, 10);
    pm.registerAdapter(adapter);

    await pm.join('guild-vl-A', 'channel-1');
    assert(adapter.getVoiceStatus('guild-vl-A') === 'CONNECTED', 'Bot joined voice channel');
    assert(!pm.voiceLifecycleManager.isTimerActive('guild-vl-A'), 'No timer active when humans present');

    // Simulate member event where humans still remain
    pm.voiceLifecycleManager.handleHumanCountChange('guild-vl-A', 1);
    assert(adapter.getVoiceStatus('guild-vl-A') === 'CONNECTED', 'Bot remains connected with 1 human');
    assert(!pm.voiceLifecycleManager.isTimerActive('guild-vl-A'), 'No timer active while 1 human remains');
  }

  // ─────────────────────────────────────────────────────────────
  // 2. Voice Lifecycle: Test B (All humans leave, human rejoins)
  // ─────────────────────────────────────────────────────────────
  console.log('\nTest 2: Voice Lifecycle - All Humans Leave & Rejoin (Test B)');
  {
    const adapter = new Phase4MockAdapter();
    const pm = new PlaybackManager(logger, queueManager, 10);
    pm.registerAdapter(adapter);

    await pm.join('guild-vl-B', 'channel-1');
    // All humans leave
    pm.voiceLifecycleManager.handleHumanCountChange('guild-vl-B', 0);
    assert(pm.voiceLifecycleManager.isTimerActive('guild-vl-B'), 'Inactivity timer started when humans = 0');
    assert(pm.voiceLifecycleManager.getTimerReason('guild-vl-B') === 'empty_channel', 'Timer reason is empty_channel');

    // Human rejoins before timeout
    pm.voiceLifecycleManager.handleHumanCountChange('guild-vl-B', 1);
    assert(!pm.voiceLifecycleManager.isTimerActive('guild-vl-B'), 'Timer canceled when human rejoins');
    assert(adapter.getVoiceStatus('guild-vl-B') === 'CONNECTED', 'Bot remains connected after human rejoins');
  }

  // ─────────────────────────────────────────────────────────────
  // 3. Voice Lifecycle: Test C (Queue finishes, new track cancels)
  // ─────────────────────────────────────────────────────────────
  console.log('\nTest 3: Voice Lifecycle - Queue Finishes & New Track Cancels (Test C)');
  {
    const adapter = new Phase4MockAdapter();
    adapter.humanCount = 2;
    const pm = new PlaybackManager(logger, queueManager, 10);
    pm.registerAdapter(adapter);

    await pm.join('guild-vl-C', 'channel-1');
    await pm.play('guild-vl-C', new MockAudioSource('song1.mp3'), { name: 'song1.mp3', path: 'song1.mp3' });

    // Track finishes, queue is empty, humans still present
    adapter.triggerTrackEnd('guild-vl-C');
    await new Promise((r) => setTimeout(r, 50));
    assert(pm.voiceLifecycleManager.isTimerActive('guild-vl-C'), 'Idle timer started when queue became empty');
    assert(pm.voiceLifecycleManager.getTimerReason('guild-vl-C') === 'queue_empty', 'Timer reason is queue_empty');

    // New track starts before timeout
    await pm.play('guild-vl-C', new MockAudioSource('song2.mp3'), { name: 'song2.mp3', path: 'song2.mp3' });
    assert(!pm.voiceLifecycleManager.isTimerActive('guild-vl-C'), 'Idle timer canceled when new track starts');
  }

  // ─────────────────────────────────────────────────────────────
  // 4. Voice Lifecycle: Test D (Timeout expires -> auto-leave)
  // ─────────────────────────────────────────────────────────────
  console.log('\nTest 4: Voice Lifecycle - Timeout Expires (Test D)');
  {
    const adapter = new Phase4MockAdapter();
    // Use short 0.05 second timeout for test speed
    const pm = new PlaybackManager(logger, queueManager, 0.05);
    pm.voiceLifecycleManager.setTimeoutSeconds('guild-vl-D', 0.05);
    pm.registerAdapter(adapter);

    await pm.join('guild-vl-D', 'channel-1');
    pm.voiceLifecycleManager.handleHumanCountChange('guild-vl-D', 0);
    assert(pm.voiceLifecycleManager.isTimerActive('guild-vl-D'), 'Timer active for 0.05s');

    // Wait for timeout to expire
    await new Promise((r) => setTimeout(r, 200));
    assert(adapter.getVoiceStatus('guild-vl-D') === 'DISCONNECTED', 'Bot cleanly disconnected upon timeout');
    assert(!pm.voiceLifecycleManager.isTimerActive('guild-vl-D'), 'Timer cleaned up after auto-leave');
  }

  // ─────────────────────────────────────────────────────────────
  // 5. Voice Lifecycle: Test E (stayInChannel = true)
  // ─────────────────────────────────────────────────────────────
  console.log('\nTest 5: Voice Lifecycle - Stay In Channel (Test E)');
  {
    const adapter = new Phase4MockAdapter();
    const pm = new PlaybackManager(logger, queueManager, 0.1);
    pm.voiceLifecycleManager.setTimeoutSeconds('guild-vl-E', 0.1);
    pm.registerAdapter(adapter);

    await pm.join('guild-vl-E', 'channel-1');
    pm.setStayInChannel('guild-vl-E', true);
    assert(pm.isStayInChannel('guild-vl-E'), 'stayInChannel is enabled');

    // Humans leave
    pm.voiceLifecycleManager.handleHumanCountChange('guild-vl-E', 0);
    assert(!pm.voiceLifecycleManager.isTimerActive('guild-vl-E'), 'No timer started when stayInChannel is true');

    // Wait short delay
    await new Promise((r) => setTimeout(r, 150));
    assert(adapter.getVoiceStatus('guild-vl-E') === 'CONNECTED', 'Bot remains connected indefinitely');
  }

  // ─────────────────────────────────────────────────────────────
  // 6. Volume Control (0, 50, 100, 150, 200, invalid inputs)
  // ─────────────────────────────────────────────────────────────
  console.log('\nTest 6: Volume Controls & Clamping');
  {
    const adapter = new Phase4MockAdapter();
    const pm = new PlaybackManager(logger, queueManager);
    pm.registerAdapter(adapter);

    assert(clampVolume(0) === 0, 'clampVolume 0 -> 0');
    assert(clampVolume(50) === 50, 'clampVolume 50 -> 50');
    assert(clampVolume(100) === 100, 'clampVolume 100 -> 100');
    assert(clampVolume(150) === 150, 'clampVolume 150 -> 150');
    assert(clampVolume(200) === 200, 'clampVolume 200 -> 200');
    assert(clampVolume(-10) === 0, 'clampVolume -10 clamped to 0');
    assert(clampVolume(250) === 200, 'clampVolume 250 clamped to 200');
    assert(clampVolume(NaN) === 100, 'clampVolume NaN defaults to 100');

    pm.setVolume('guild-vol', 75);
    assert(pm.getVolume('guild-vol') === 75, 'pm.getVolume returns 75');
    assert(adapter.volume === 75, 'adapter received volume 75');

    // Isolation: Guild B volume untouched
    assert(pm.getVolume('guild-other') === 100, 'Guild other volume remains 100');
  }

  // ─────────────────────────────────────────────────────────────
  // 7. Audio Filters: Bassboost, Speed with atempo chaining, Nightcore
  // ─────────────────────────────────────────────────────────────
  console.log('\nTest 7: Audio Filters & FFmpeg Filter Generation');
  {
    // 7.1 Bassboost
    const bassArgs = buildAudioFilterArgs({ bassboost: true, speed: 1.0, nightcore: false });
    assert(bassArgs.includes('bass=g=5:f=110:w=0.6'), 'Bassboost generates conservative bass filter');

    // 7.2 Speed & atempo chaining
    const tempo1 = buildAtempoFilterChain(1.5);
    assert(tempo1.length === 1 && tempo1[0] === 'atempo=1.500', 'Speed 1.5 generates atempo=1.500');

    const tempo2 = buildAtempoFilterChain(2.0);
    assert(tempo2.length === 1 && tempo2[0] === 'atempo=2.000', 'Speed 2.0 generates atempo=2.000');

    const tempoChained = buildAtempoFilterChain(3.0);
    assert(
      tempoChained.length === 2 && tempoChained[0] === 'atempo=2.0' && tempoChained[1] === 'atempo=1.500',
      'Speed 3.0 chains atempo=2.0 and atempo=1.500',
    );

    const tempoLow = buildAtempoFilterChain(0.25);
    assert(
      tempoLow.length === 2 && tempoLow[0] === 'atempo=0.5' && tempoLow[1] === 'atempo=0.500',
      'Speed 0.25 chains atempo=0.5 and atempo=0.500',
    );

    // 7.3 Nightcore
    const ncArgs = buildAudioFilterArgs({ bassboost: false, speed: 1.0, nightcore: true });
    assert(
      ncArgs.some((f) => f.includes('asetrate=48000*1.25')),
      'Nightcore generates asetrate pitch and tempo modifier',
    );

    // 7.4 Effective speed
    assert(calculateEffectiveSpeed(1.0, true) === 1.25, 'Nightcore effective speed with 1.0x = 1.25x');
    assert(calculateEffectiveSpeed(1.5, true) === 1.875, 'Nightcore effective speed with 1.5x = 1.875x');

    // 7.5 Rebuild pipeline while playing
    const adapter = new Phase4MockAdapter();
    const pm = new PlaybackManager(logger, queueManager);
    pm.registerAdapter(adapter);
    await pm.join('guild-filters', 'chan-1');
    await pm.play('guild-filters', new MockAudioSource('song.mp3'), { name: 'song.mp3', path: 'song.mp3' });

    assert(adapter.rebuildCount === 0, 'No rebuild before filter change');
    await pm.setBassboost('guild-filters', true);
    assert(adapter.rebuildCount === 1, 'Audio pipeline rebuilt when bassboost toggled');
    assert(adapter.lastRebuildSeek === 15, 'Rebuilt stream resumed at 15s elapsed duration');

    await pm.setSpeed('guild-filters', 1.25);
    assert(adapter.rebuildCount === 2, 'Audio pipeline rebuilt when speed changed');

    await pm.setNightcore('guild-filters', true);
    assert(adapter.rebuildCount === 3, 'Audio pipeline rebuilt when nightcore enabled');
  }

  // ─────────────────────────────────────────────────────────────
  // 8. Queue Manipulation: /shuffle, /remove, /clear, /move
  // ─────────────────────────────────────────────────────────────
  console.log('\nTest 8: Queue Manipulation (/shuffle, /remove, /clear, /move)');
  {
    const qm = new QueueManager(logger);
    const gid = 'guild-queue-ops';

    // 8.1 Shuffle empty & 1 item
    assert(!qm.shuffle(gid), 'Shuffle on empty queue returns false');
    qm.addTrack(gid, { name: 'Track 1', path: '1.mp3' });
    assert(!qm.shuffle(gid), 'Shuffle on 1 item queue returns false');

    // Multiple items
    qm.addTrack(gid, { name: 'Track 2', path: '2.mp3' });
    qm.addTrack(gid, { name: 'Track 3', path: '3.mp3' });
    qm.addTrack(gid, { name: 'Track 4', path: '4.mp3' });
    assert(qm.getQueueLength(gid) === 4, 'Queue has 4 items before shuffle');
    assert(qm.shuffle(gid), 'Shuffle on 4 items returns true');
    assert(qm.getQueueLength(gid) === 4, 'Queue still has 4 items after shuffle');

    // 8.2 Move track
    qm.clearQueue(gid);
    qm.addTrack(gid, { name: 'A', path: 'a.mp3' });
    qm.addTrack(gid, { name: 'B', path: 'b.mp3' });
    qm.addTrack(gid, { name: 'C', path: 'c.mp3' });
    qm.addTrack(gid, { name: 'D', path: 'd.mp3' });

    // Move D (pos 4) to pos 1: should become [D, A, B, C]
    const moved = qm.moveTrack(gid, 4, 1, true);
    assert(moved?.name === 'D', 'Moved track is D');
    const display = qm.getDisplayQueue(gid);
    assert(display[0].name === 'D', 'Pos 1 is now D');
    assert(display[1].name === 'A', 'Pos 2 is now A');
    assert(display[2].name === 'B', 'Pos 3 is now B');
    assert(display[3].name === 'C', 'Pos 4 is now C');

    // Invalid moves
    assert(qm.moveTrack(gid, 0, 2, true) === null, 'Move with from=0 returns null');
    assert(qm.moveTrack(gid, 1, 99, true) === null, 'Move with to=99 returns null');
    assert(qm.moveTrack(gid, 2, 2, true) === null, 'Move from=2 to=2 returns null');

    // 8.3 Remove track
    const removed = qm.removeByIndex(gid, 2, true); // removes A
    assert(removed?.name === 'A', 'Removed track at index 2 was A');
    assert(qm.getQueueLength(gid) === 3, 'Queue length is now 3');
    assert(qm.getDisplayQueue(gid)[0].name === 'D', 'Pos 1 is D');
    assert(qm.getDisplayQueue(gid)[1].name === 'B', 'Pos 2 is B');

    // Invalid remove
    assert(qm.removeByIndex(gid, 0, true) === null, 'Remove pos 0 returns null');
    assert(qm.removeByIndex(gid, 10, true) === null, 'Remove pos 10 returns null');

    // 8.4 Clear queue
    qm.clearQueue(gid);
    assert(qm.isEmpty(gid), 'Queue is empty after clear');
  }

  // ─────────────────────────────────────────────────────────────
  // 9. Loop Modes: off, track, queue, skip interaction
  // ─────────────────────────────────────────────────────────────
  console.log('\nTest 9: Loop Modes (off, track, queue, /skip)');
  {
    // 9.1 Track loop: repeats current track naturally
    const adapter = new Phase4MockAdapter();
    const pm = new PlaybackManager(logger, new QueueManager(logger));
    pm.registerAdapter(adapter);
    await pm.join('guild-loop', 'chan-1');

    await pm.play('guild-loop', new MockAudioSource('track_a.mp3'), { name: 'track_a.mp3', path: 'track_a.mp3' });
    pm.queueManager.addTrack('guild-loop', { name: 'track_b.wav', path: 'track_b.wav' });

    pm.setLoopMode('guild-loop', 'track');
    assert(pm.getLoopMode('guild-loop') === 'track', 'Loop mode set to track');

    // Track A finishes naturally
    adapter.triggerTrackEnd('guild-loop');
    assert(pm.getCurrentTrack('guild-loop')?.name === 'track_a.mp3', 'Track loop replayed track_a.mp3 naturally');
    assert(pm.queueManager.getQueueLength('guild-loop') === 1, 'track_b.wav remains in queue without duplicate insertions');

    // 9.2 Track loop + /skip: breaks repetition and plays next queued track
    const skipRes = await pm.skip('guild-loop');
    assert(skipRes.skipped, 'Skip succeeded');
    assert(skipRes.nowPlaying?.name === 'track_b.wav', 'Skip advanced to track_b.wav, breaking track loop repetition');

    // 9.3 Queue loop: re-enqueues track at the back of the queue
    pm.setLoopMode('guild-loop', 'queue');
    assert(pm.getLoopMode('guild-loop') === 'queue', 'Loop mode set to queue');

    // track_b.wav finishes naturally: should be re-enqueued at the end of the queue
    adapter.triggerTrackEnd('guild-loop');
    // track_b was re-enqueued and became the next track in queue, so it starts playing track_b again
    assert(pm.getCurrentTrack('guild-loop')?.name === 'track_b.wav', 'Queue loop replayed track_b.wav via queue cycle');

    // 9.4 Queue loop + /clear
    pm.queueManager.addTrack('guild-loop', { name: 'track_c.ogg', path: 'track_c.ogg' });
    pm.queueManager.addTrack('guild-loop', { name: 'track_d.flac', path: 'track_d.flac' });
    pm.clearQueue('guild-loop');
    assert(pm.queueManager.isEmpty('guild-loop'), 'Queue loop + clear removed all queued tracks');
    assert(pm.getCurrentTrack('guild-loop') !== null, 'Current track continues playing after clear');
  }

  // ─────────────────────────────────────────────────────────────
  // 10. Discord Slash Commands Handler Verification
  // ─────────────────────────────────────────────────────────────
  console.log('\nTest 10: Discord Slash Commands Interactions');
  {
    const adapter = new Phase4MockAdapter();
    const pm = new PlaybackManager(logger, new QueueManager(logger));
    pm.registerAdapter(adapter);
    await pm.join('guild-slash', 'chan-1');

    // /volume 80
    const intVol = createMockInteraction('volume', 'guild-slash', { level: 80 });
    await handleChatInputCommand(intVol as any, pm);
    assert(intVol.responseText?.includes('80%'), '/volume 80 responded with 80%');
    assert(pm.getVolume('guild-slash') === 80, 'pm volume is 80');

    // /volume 250 (validation error)
    const intVolErr = createMockInteraction('volume', 'guild-slash', { level: 250 });
    await handleChatInputCommand(intVolErr as any, pm);
    assert(intVolErr.responseText?.includes('between 0 and 200'), '/volume 250 rejected with validation error');

    // /loop track
    const intLoop = createMockInteraction('loop', 'guild-slash', { mode: 'track' });
    await handleChatInputCommand(intLoop as any, pm);
    assert(intLoop.responseText?.includes('Track'), '/loop track set mode to Track');
    assert(pm.getLoopMode('guild-slash') === 'track', 'pm loop mode is track');

    // /stay on
    const intStay = createMockInteraction('stay', 'guild-slash', { mode: 'on' });
    await handleChatInputCommand(intStay as any, pm);
    assert(intStay.responseText?.includes('ON'), '/stay on responded with ON');
    assert(pm.isStayInChannel('guild-slash'), 'stayInChannel is true');

    // Add items and test /shuffle, /move, /remove, /clear
    pm.queueManager.addTrack('guild-slash', { name: 'Item1', path: '1.mp3' });
    pm.queueManager.addTrack('guild-slash', { name: 'Item2', path: '2.mp3' });
    pm.queueManager.addTrack('guild-slash', { name: 'Item3', path: '3.mp3' });

    // /move 3 1
    const intMove = createMockInteraction('move', 'guild-slash', { from: 3, to: 1 });
    await handleChatInputCommand(intMove as any, pm);
    assert(intMove.responseText?.includes('Moved'), '/move moved track successfully');

    // /remove 1
    const intRemove = createMockInteraction('remove', 'guild-slash', { index: 1 });
    await handleChatInputCommand(intRemove as any, pm);
    assert(intRemove.responseText?.includes('Removed'), '/remove removed track successfully');

    // /clear
    const intClear = createMockInteraction('clear', 'guild-slash');
    await handleChatInputCommand(intClear as any, pm);
    assert(intClear.responseText?.includes('Cleared'), '/clear cleared queue');
  }

  console.log('\n======================================================');
  console.log(`Phase 4 Test Suite Results: ${passed} passed, ${failed} failed`);
  console.log('======================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runPhase4Tests().catch((err) => {
  console.error('Fatal error during Phase 4 tests:', err);
  process.exit(1);
});
