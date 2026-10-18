import assert from 'node:assert';
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
  handleChatInputCommand,
  slashCommandDefinitions,
} from '../discord/commands';
import {
  handleControlPanelButton,
  handleControlPanelModal,
} from '../discord/control-panel';

const logger = createLogger('playnext-test');

class MockVoiceAdapter implements VoicePlatformAdapter {
  readonly platform = 'mock-discord';
  public voiceStatus: VoiceConnectionStatus = 'CONNECTED';
  public playerStatus: PlaybackStatus = 'IDLE';
  public currentTrack: AudioTrackInfo | null = null;

  private stateListeners = new Set<(state: VoicePlatformState) => void>();
  private errorListeners = new Set<(guildId: string, err: Error) => void>();
  private trackEndListeners = new Set<(guildId: string) => void>();

  async joinVoice(guildId: string, channelId: string): Promise<void> {
    this.voiceStatus = 'CONNECTED';
  }

  async leaveVoice(guildId: string): Promise<void> {
    this.voiceStatus = 'DISCONNECTED';
  }

  getVoiceStatus(guildId: string): VoiceConnectionStatus {
    return this.voiceStatus;
  }

  getCurrentTrack(guildId: string): AudioTrackInfo | null {
    return this.currentTrack;
  }

  async play(guildId: string, source: AudioSource): Promise<void> {
    this.playerStatus = 'PLAYING';
    this.currentTrack = {
      name: source.identifier,
      source: 'local',
      duration: 180,
    } as any;
  }

  pause(guildId: string): boolean {
    this.playerStatus = 'PAUSED';
    return true;
  }

  resume(guildId: string): boolean {
    this.playerStatus = 'PLAYING';
    return true;
  }

  stop(guildId: string): boolean {
    this.playerStatus = 'IDLE';
    this.currentTrack = null;
    return true;
  }

  async seek(guildId: string, positionSeconds: number): Promise<number | null> {
    return positionSeconds;
  }

  getPlaybackStatus(guildId: string): PlaybackStatus {
    return this.playerStatus;
  }

  getState(guildId: string): VoicePlatformState {
    return {
      voiceState: this.voiceStatus,
      playerState: this.playerStatus,
      channelId: 'mock-channel',
    } as any;
  }

  onStateChange(listener: (state: VoicePlatformState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onError(listener: (guildId: string, err: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  onTrackEnd(listener: (guildId: string) => void): () => void {
    this.trackEndListeners.add(listener);
    return () => this.trackEndListeners.delete(listener);
  }
}

async function runPlayNextTests() {
  console.log('--- Starting PlayNext Tests ---');

  // ─── 1. QueueManager addTrackNext Ordering Tests ─────────────────────────────
  console.log('Testing QueueManager.addTrackNext ordering...');
  const queueManager = new QueueManager(logger);
  const guildId = 'test-guild-1';

  // Seed with 3 regular queue songs: [Song A, Song B, Song C]
  queueManager.addTrack(guildId, { name: 'Song A', path: 'a.mp3' });
  queueManager.addTrack(guildId, { name: 'Song B', path: 'b.mp3' });
  queueManager.addTrack(guildId, { name: 'Song C', path: 'c.mp3' });

  // 1st playnext: Song 1 should go to top of queue (index 0, position 1)
  const res1 = queueManager.addTrackNext(guildId, { name: 'Song 1', path: '1.mp3' });
  assert.strictEqual(res1.position, 1, 'First playnext song should be at position 1');
  let display = queueManager.getDisplayQueue(guildId);
  assert.strictEqual(display[0].name, 'Song 1');
  assert.strictEqual(display[0].playNext, true);
  assert.strictEqual(display[1].name, 'Song A');
  console.log('✓ 1st playnext inserted at position 1 (top of queue)');

  // 2nd playnext: Song 2 should play after the first playnext song (index 1, position 2)
  const res2 = queueManager.addTrackNext(guildId, { name: 'Song 2', path: '2.mp3' });
  assert.strictEqual(res2.position, 2, 'Second playnext song should be at position 2 (after first one)');
  display = queueManager.getDisplayQueue(guildId);
  assert.strictEqual(display[0].name, 'Song 1');
  assert.strictEqual(display[1].name, 'Song 2');
  assert.strictEqual(display[1].playNext, true);
  assert.strictEqual(display[2].name, 'Song A');
  assert.strictEqual(display[3].name, 'Song B');
  assert.strictEqual(display[4].name, 'Song C');
  console.log('✓ 2nd playnext inserted at position 2 (after 1st playnext, before existing queue)');

  // 3rd playnext: Song 3 should play after Song 2 (index 2, position 3)
  const res3 = queueManager.addTrackNext(guildId, { name: 'Song 3', path: '3.mp3' });
  assert.strictEqual(res3.position, 3, 'Third playnext song should be at position 3');
  display = queueManager.getDisplayQueue(guildId);
  assert.strictEqual(display[0].name, 'Song 1');
  assert.strictEqual(display[1].name, 'Song 2');
  assert.strictEqual(display[2].name, 'Song 3');
  assert.strictEqual(display[3].name, 'Song A');
  console.log('✓ 3rd playnext inserted at position 3 (after 2nd playnext, before existing queue)');

  // Normal enqueue: Song D goes to the end
  queueManager.addTrack(guildId, { name: 'Song D', path: 'd.mp3' });
  display = queueManager.getDisplayQueue(guildId);
  assert.strictEqual(display[display.length - 1].name, 'Song D');
  assert.strictEqual(display[display.length - 1].playNext, undefined);
  console.log('✓ Normal track appended to the end of the queue');

  // Dequeue Song 1 (current track finished)
  const nextTrack = queueManager.getNext(guildId);
  assert.strictEqual(nextTrack?.name, 'Song 1');

  // Now queue has: [Song 2 (playNext), Song 3 (playNext), Song A, Song B, Song C, Song D]
  // Adding Song 4 via playnext should insert after Song 3 (position 3), before Song A!
  const res4 = queueManager.addTrackNext(guildId, { name: 'Song 4', path: '4.mp3' });
  assert.strictEqual(res4.position, 3, 'Song 4 should insert after Song 3 (contiguous playNext block)');
  display = queueManager.getDisplayQueue(guildId);
  assert.strictEqual(display[0].name, 'Song 2');
  assert.strictEqual(display[1].name, 'Song 3');
  assert.strictEqual(display[2].name, 'Song 4');
  assert.strictEqual(display[3].name, 'Song A');
  console.log('✓ Subsequent playnext correctly preserves playNext chain after dequeue');

  // ─── 2. PlaybackManager playNext / play with playNext flag ───────────────────
  console.log('Testing PlaybackManager playNext integration...');
  const mockAdapter = new MockVoiceAdapter();
  const playbackManager = new PlaybackManager(logger, new QueueManager(logger));
  playbackManager.registerAdapter(mockAdapter);

  const dummySource = (name: string): AudioSource => ({
    identifier: name,
    sourceType: 'file',
    async getStream() { return null as any; },
    async validate() {},
    async getMetadata() { return { title: name, duration: 180 }; },
  });

  // Track 0 starts playing (idle -> playing immediately)
  const play0 = await playbackManager.play(guildId, dummySource('Track 0'), {
    name: 'Track 0',
    path: '0.mp3',
  });
  assert.strictEqual(play0.status, 'started');

  // Add normal Track A to queue
  const playA = await playbackManager.play(guildId, dummySource('Track A'), {
    name: 'Track A',
    path: 'a.mp3',
  });
  assert.strictEqual(playA.status, 'queued');
  assert.strictEqual(playA.position, 1);

  // Call playNext with Track 1 -> should go to position 1 (before Track A)
  const play1 = await playbackManager.playNext(guildId, dummySource('Track 1'), {
    name: 'Track 1',
    path: '1.mp3',
  });
  assert.strictEqual(play1.status, 'queued');
  assert.strictEqual(play1.position, 1);

  // Call playNext with Track 2 -> should go to position 2 (after Track 1, before Track A)
  const play2 = await playbackManager.playNext(guildId, dummySource('Track 2'), {
    name: 'Track 2',
    path: '2.mp3',
  });
  assert.strictEqual(play2.status, 'queued');
  assert.strictEqual(play2.position, 2);

  const currentDisplay = playbackManager.queueManager.getDisplayQueue(guildId);
  assert.strictEqual(currentDisplay[0].name, 'Track 1');
  assert.strictEqual(currentDisplay[1].name, 'Track 2');
  assert.strictEqual(currentDisplay[2].name, 'Track A');
  console.log('✓ PlaybackManager.playNext places Track 1 at pos 1, Track 2 at pos 2, ahead of Track A');

  // ─── 3. Slash Command Definitions & Command Handler ─────────────────────────
  console.log('Testing Slash Command Definitions for playnext...');
  const playnextDef = slashCommandDefinitions.find((def) => def.name === 'playnext');
  assert(playnextDef, 'playnext slash command must be registered');
  console.log('✓ /playnext command registered in slashCommandDefinitions');

  // Test slash command execution
  let repliedText = '';
  let repliedEmbeds: any[] = [];
  const mockInteraction = {
    commandName: 'playnext',
    guildId,
    guild: {
      channels: {
        fetch: async () => ({ id: 'mock-channel', name: 'General', permissionsFor: () => ({ has: () => true }) }),
      },
    },
    member: {
      id: 'user-1',
      displayName: 'TestUser',
      voice: { channel: { id: 'mock-channel', name: 'General', permissionsFor: () => ({ has: () => true }) } },
    },
    options: {
      getString: (name: string) => {
        if (name === 'input') return 'track_a.mp3';
        return null;
      },
    },
    deferReply: async () => {},
    editReply: async (options: any) => {
      repliedText = typeof options === 'string' ? options : options.content || '';
      repliedEmbeds = options.embeds || [];
    },
    reply: async (options: any) => {
      repliedText = typeof options === 'string' ? options : options.content || '';
      repliedEmbeds = options.embeds || [];
    },
  };

  await handleChatInputCommand(mockInteraction as any, playbackManager);
  assert(repliedText.includes('Added to play next'), 'Command response must indicate track added to play next');
  console.log('✓ /playnext slash command executed and confirmed play next position');

  // ─── 4. Control Panel Button & Modal Handlers ──────────────────────────────
  console.log('Testing Control Panel Button & Modal Handlers...');
  let modalShown: any = null;
  const mockButtonInteraction = {
    guildId,
    customId: 'gakki:playnext',
    showModal: async (m: any) => {
      modalShown = m;
    },
    reply: async () => {},
    deferred: false,
    replied: false,
  };

  await handleControlPanelButton(mockButtonInteraction as any, playbackManager);
  assert(modalShown, 'Control panel gakki:playnext button must open a modal');
  assert.strictEqual(modalShown.data.custom_id, 'gakki:playnext_modal');
  console.log('✓ gakki:playnext button triggers gakki:playnext_modal');

  // Test modal submit extraction
  const mockModalInteraction = {
    customId: 'gakki:playnext_modal',
    fields: {
      getTextInputValue: (fieldId: string) => {
        if (fieldId === 'gakki:playnext_input') return 'Alan Walker - Faded';
        return '';
      },
    },
    reply: async () => {},
  };
  const modalInput = await handleControlPanelModal(mockModalInteraction as any);
  assert.strictEqual(modalInput, 'Alan Walker - Faded');
  console.log('✓ handleControlPanelModal successfully extracts gakki:playnext_input');

  console.log('\n====================================');
  console.log('All PlayNext tests passed successfully!');
  console.log('====================================\n');
}

runPlayNextTests().catch((err) => {
  console.error('PlayNext test failed:', err);
  process.exit(1);
});
