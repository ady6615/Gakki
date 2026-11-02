import assert from 'node:assert';
import {
  PlaybackManager,
  QueueManager,
  LocalCommandMatcher,
  createLogger,
  type VoicePlatformAdapter,
  type VoicePlatformState,
  type AudioTrackInfo,
  type VoiceConnectionStatus,
  type PlaybackStatus,
  type AudioSource,
} from '@gakki/core';
import {
  handleControlPanelButton,
  handleControlPanelSelectMenu,
} from '../discord/control-panel';
import { handleChatInputCommand } from '../discord/commands';

class MockVoiceAdapter implements VoicePlatformAdapter {
  readonly platform = 'mock-discord';
  public voiceStatus: VoiceConnectionStatus = 'CONNECTED';
  public playerStatus: PlaybackStatus = 'PLAYING';
  public currentTrack: AudioTrackInfo | null = null;

  private stateListeners: Set<(state: VoicePlatformState) => void> = new Set();
  private errorListeners: Set<(guildId: string, err: Error) => void> = new Set();

  async joinVoice(_guildId: string, _channelId: string): Promise<void> {}
  async leaveVoice(_guildId: string): Promise<void> {}
  getVoiceStatus(_guildId: string): VoiceConnectionStatus { return this.voiceStatus; }

  async play(guildId: string, source: AudioSource): Promise<void> {
    const meta = await source.getMetadata();
    this.currentTrack = {
      name: meta.title,
      duration: meta.duration ?? 200,
      artist: meta.artist ?? 'Test Artist',
      filePath: source.identifier,
      sourceType: source.sourceType,
    };
    this.playerStatus = 'PLAYING';
    this.emitState(guildId);
  }

  pause(guildId: string): boolean {
    this.playerStatus = 'PAUSED';
    this.emitState(guildId);
    return true;
  }

  resume(guildId: string): boolean {
    this.playerStatus = 'PLAYING';
    this.emitState(guildId);
    return true;
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

  onStateChange(listener: (state: VoicePlatformState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onError(listener: (guildId: string, err: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  onTrackEnd(_listener: (guildId: string) => void): () => void {
    return () => {};
  }

  private emitState(guildId: string): void {
    const s = this.getState(guildId);
    for (const listener of this.stateListeners) {
      listener(s);
    }
  }
}

async function runReverseTests() {
  console.log('=== Starting Control Panel Reverse Command Tests ===\n');
  const guildId = 'test-reverse-guild';
  const logger = createLogger('reverse-test');
  const queueManager = new QueueManager(logger);
  const mockAdapter = new MockVoiceAdapter();
  const playbackManager = new PlaybackManager(logger, queueManager);
  playbackManager.registerAdapter(mockAdapter);

  // ─── 1. QueueManager.reverse() Core Logic Tests ─────────────────────────────
  console.log('1. Testing QueueManager.reverse()...');

  // Empty queue
  assert.strictEqual(queueManager.reverse(guildId), false, 'Reversing empty queue should return false');

  // Single track queue
  queueManager.addTrack(guildId, {
    name: 'Song 1',
    path: '/path/1',
    duration: 180,
    addedBy: 'User',
  });
  assert.strictEqual(queueManager.reverse(guildId), false, 'Reversing 1-track queue should return false');

  // Add more tracks: queue is now Song 1, Song 2, Song 3, Song 4
  queueManager.addTracks(guildId, [
    { name: 'Song 2', path: '/path/2', duration: 200, addedBy: 'User' },
    { name: 'Song 3', path: '/path/3', duration: 220, addedBy: 'User' },
    { name: 'Song 4', path: '/path/4', duration: 240, addedBy: 'User' },
  ]);

  const initialItems = queueManager.inspectQueue(guildId);
  assert.strictEqual(initialItems.length, 4);
  assert.deepStrictEqual(
    initialItems.map((t) => t.name),
    ['Song 1', 'Song 2', 'Song 3', 'Song 4'],
    'Initial queue order must be 1, 2, 3, 4',
  );

  // Reverse queue upside down
  const reversedOk = queueManager.reverse(guildId);
  assert.strictEqual(reversedOk, true, 'Reversing 4-track queue should return true');

  const reversedItems = queueManager.inspectQueue(guildId);
  assert.strictEqual(reversedItems.length, 4);
  assert.deepStrictEqual(
    reversedItems.map((t) => t.name),
    ['Song 4', 'Song 3', 'Song 2', 'Song 1'],
    'Queue must be reversed upside down (Song 4, Song 3, Song 2, Song 1)',
  );
  console.log('✓ QueueManager.reverse() successfully inverted queue order upside down');

  // Reverse again to return to original order
  queueManager.reverse(guildId);
  const doubleReversed = queueManager.inspectQueue(guildId);
  assert.deepStrictEqual(
    doubleReversed.map((t) => t.name),
    ['Song 1', 'Song 2', 'Song 3', 'Song 4'],
    'Reversing twice returns to original order',
  );
  console.log('✓ Double reverse restores original queue order');

  // ─── 2. PlaybackManager.reverseQueue() & Event Notification ─────────────────
  console.log('\n2. Testing PlaybackManager.reverseQueue()...');
  let queueUpdateFired = false;
  playbackManager.onQueueUpdate((event) => {
    if (event.guildId === guildId) {
      queueUpdateFired = true;
    }
  });

  const pmReversed = playbackManager.reverseQueue(guildId);
  assert.strictEqual(pmReversed, true);
  assert.strictEqual(queueUpdateFired, true, 'reverseQueue must emit a queue update event');
  assert.strictEqual(queueManager.inspectQueue(guildId)[0].name, 'Song 4');
  console.log('✓ PlaybackManager.reverseQueue() emitted queue update and reversed tracks');

  // ─── 3. Control Panel Button (gakki:reverse) Interaction ─────────────────────
  console.log('\n3. Testing Control Panel gakki:reverse Button...');
  let buttonReply = '';
  const mockButtonInteraction = {
    guildId,
    customId: 'gakki:reverse',
    reply: async (options: any) => {
      buttonReply = typeof options === 'string' ? options : options.content;
    },
    deferred: false,
    replied: false,
  };

  await handleControlPanelButton(mockButtonInteraction as any, playbackManager);
  assert(buttonReply.includes('Reversed'), 'Button interaction should reply confirming reversal');
  assert(buttonReply.includes('4'), 'Button reply should mention 4 tracks');
  assert(buttonReply.includes('opposite order'), 'Button reply should mention opposite order');
  // Since it was reversed from [4,3,2,1], it is now back to [1,2,3,4]
  assert.strictEqual(queueManager.inspectQueue(guildId)[0].name, 'Song 1');
  console.log('✓ gakki:reverse button interaction successfully handled');

  // Test button when queue has fewer than 2 items
  queueManager.clearQueue(guildId);
  buttonReply = '';
  await handleControlPanelButton(mockButtonInteraction as any, playbackManager);
  assert(buttonReply.includes('Need at least 2 tracks'), 'Button reply should reject when queue < 2 items');
  console.log('✓ gakki:reverse button gracefully informs user when queue has insufficient tracks');

  // ─── 4. Control Panel Select Menu (queue_reverse) ───────────────────────────
  console.log('\n4. Testing Control Panel Select Menu queue_reverse...');
  queueManager.addTracks(guildId, [
    { name: 'Track A', path: '/a', duration: 100, addedBy: 'User' },
    { name: 'Track B', path: '/b', duration: 100, addedBy: 'User' },
  ]);

  let menuReply = '';
  const mockMenuInteraction = {
    guildId,
    customId: 'gakki:effects_slider',
    values: ['queue_reverse'],
    reply: async (options: any) => {
      menuReply = typeof options === 'string' ? options : options.content;
    },
    deferred: false,
    replied: false,
  };

  await handleControlPanelSelectMenu(mockMenuInteraction as any, playbackManager);
  assert(menuReply.includes('Reversed'), 'Menu interaction should reply confirming reversal');
  assert.strictEqual(queueManager.inspectQueue(guildId)[0].name, 'Track B');
  console.log('✓ queue_reverse select menu option successfully reverses queue');

  // ─── 5. Slash Command /reverse ──────────────────────────────────────────────
  console.log('\n5. Testing /reverse Slash Command...');
  let slashReply = '';
  const mockSlashInteraction = {
    guildId,
    commandName: 'reverse',
    options: {
      getString: () => null,
      getInteger: () => null,
      getNumber: () => null,
    },
    reply: async (options: any) => {
      slashReply = typeof options === 'string' ? options : options.content;
    },
  };

  await handleChatInputCommand(mockSlashInteraction as any, playbackManager);
  assert(slashReply.includes('Reversed'), 'Slash command should reply with confirmation');
  assert.strictEqual(queueManager.inspectQueue(guildId)[0].name, 'Track A');
  console.log('✓ /reverse slash command successfully executed');

  // ─── 6. Local Command Matcher (Voice / Natural Language) ───────────────────
  console.log('\n6. Testing Voice / NLP Command Matching...');
  const match1 = LocalCommandMatcher.match('reverse');
  assert.strictEqual(match1?.intent, 'REVERSE_QUEUE');

  const match2 = LocalCommandMatcher.match('reverse queue');
  assert.strictEqual(match2?.intent, 'REVERSE_QUEUE');

  const match3 = LocalCommandMatcher.match('flip queue');
  assert.strictEqual(match3?.intent, 'REVERSE_QUEUE');

  const match4 = LocalCommandMatcher.match('invert queue');
  assert.strictEqual(match4?.intent, 'REVERSE_QUEUE');
  console.log('✓ LocalCommandMatcher accurately matches reverse intents');

  console.log('\n=============================================');
  console.log('All Reverse Command & Control Panel Tests Passed!');
  console.log('=============================================\n');
}

runReverseTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
