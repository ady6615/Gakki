import assert from 'node:assert';
import {
  PlaybackManager,
  QueueManager,
  createLogger,
  type VoicePlatformAdapter,
  type VoicePlatformState,
  type AudioTrackInfo,
  type VoiceConnectionStatus,
  type PlaybackStatus,
  type AudioSource,
  type AudioFilterConfig,
} from '@gakki/core';
import {
  handleControlPanelButton,
  handleControlPanelSelectMenu,
} from '../discord/control-panel';
import { playbackRoutes } from '../api/routes/playback.routes';
import express from 'express';
import http from 'node:http';

const logger = createLogger('test');

class MockVoiceAdapter implements VoicePlatformAdapter {
  readonly platform = 'mock-discord';
  public voiceStatus: VoiceConnectionStatus = 'CONNECTED';
  public playerStatus: PlaybackStatus = 'PLAYING';
  public currentTrack: AudioTrackInfo | null = null;
  public lastRebuildSeek: number = 0;
  public lastRebuildFilters: AudioFilterConfig | null = null;
  public simulatedDurationMs: number = 45000; // 45 seconds elapsed

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

  async rebuildCurrentStream(
    _guildId: string,
    filters: AudioFilterConfig,
    seekSeconds?: number,
  ): Promise<void> {
    this.lastRebuildFilters = filters;
    this.lastRebuildSeek = seekSeconds ?? 0;
    this.simulatedDurationMs = (seekSeconds ?? 0) * 1000;
  }

  getPlaybackDuration(_guildId: string): number {
    return this.simulatedDurationMs;
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

  private emitState(guildId: string): void {
    const s = this.getState(guildId);
    for (const l of this.stateListeners) l(s);
  }
}

async function runTests() {
  console.log('--- Starting Navigation & Seeking Control Panel Tests ---');

  const queueManager = new QueueManager(logger);
  const playbackManager = new PlaybackManager(logger, queueManager);
  const mockAdapter = new MockVoiceAdapter();
  playbackManager.registerAdapter(mockAdapter);

  const guildId = 'test-guild-nav';

  // Seed current track directly on playbackManager
  const trackInfo = {
    id: 'track-1',
    name: 'Bohemian Rhapsody',
    duration: 354, // 5:54
    path: '/music/bohemian.mp3',
  };
  (playbackManager as any).currentTracks.set(guildId, trackInfo);
  mockAdapter.currentTrack = {
    name: trackInfo.name,
    duration: trackInfo.duration,
    artist: 'Queen',
    filePath: trackInfo.path,
    sourceType: 'local',
  };
  mockAdapter.simulatedDurationMs = 45000; // Currently at 45 seconds

  // ─── 1. Test PlaybackManager.seek ──────────────────────────────────────────
  console.log('Testing PlaybackManager.seek directly...');

  // Test relative skip +10s (45s -> 55s)
  const pos1 = await playbackManager.seek(guildId, 10, true);
  assert.strictEqual(pos1, 55, 'Should navigate 10s forward from 45s to 55s');
  assert.strictEqual(mockAdapter.lastRebuildSeek, 55, 'Adapter should receive seek 55');

  // Test relative rewind -30s (55s -> 25s)
  const pos2 = await playbackManager.seek(guildId, -30, true);
  assert.strictEqual(pos2, 25, 'Should rewind 30s from 55s to 25s');
  assert.strictEqual(mockAdapter.lastRebuildSeek, 25, 'Adapter should receive seek 25');

  // Test absolute seek to 120s
  const pos3 = await playbackManager.seek(guildId, 120, false);
  assert.strictEqual(pos3, 120, 'Should seek absolutely to 120s');
  assert.strictEqual(mockAdapter.lastRebuildSeek, 120, 'Adapter should receive seek 120');

  // Test rewind past 0 clamping
  const pos4 = await playbackManager.seek(guildId, -200, true);
  assert.strictEqual(pos4, 0, 'Should clamp to 0 when rewinding past beginning');

  // Test forward past end clamping
  const pos5 = await playbackManager.seek(guildId, 500, false);
  assert.strictEqual(pos5, 352, 'Should clamp to duration - 2 when seeking past end');

  console.log('✓ PlaybackManager.seek passed all assertion checks');

  // ─── 2. Test Control Panel Button Handlers ────────────────────────────────
  console.log('Testing Control Panel Navigation Button Interactions...');
  mockAdapter.simulatedDurationMs = 60000; // at 60s

  let repliedContent = '';
  const createMockButtonInteraction = (customId: string) => ({
    guildId,
    customId,
    reply: async (options: any) => {
      repliedContent = typeof options === 'string' ? options : options.content;
    },
    deferred: false,
    replied: false,
  });

  // Test -30s button
  await handleControlPanelButton(
    createMockButtonInteraction('gakki:seek_back_30') as any,
    playbackManager,
  );
  assert(repliedContent.includes('Rewound 30s'), 'Button -30s should confirm rewind');
  assert.strictEqual(mockAdapter.lastRebuildSeek, 30, 'Should be at 30s after rewinding 30s from 60s');

  // Test +10s button
  mockAdapter.simulatedDurationMs = 30000;
  await handleControlPanelButton(
    createMockButtonInteraction('gakki:seek_fwd_10') as any,
    playbackManager,
  );
  assert(repliedContent.includes('Skipped ahead 10s'), 'Button +10s should confirm skip');
  assert.strictEqual(mockAdapter.lastRebuildSeek, 40, 'Should be at 40s after +10s from 30s');

  // Test restart 0:00 button
  await handleControlPanelButton(
    createMockButtonInteraction('gakki:seek_restart') as any,
    playbackManager,
  );
  assert(repliedContent.includes('Restarted track'), 'Button 0:00 should confirm restart');
  assert.strictEqual(mockAdapter.lastRebuildSeek, 0, 'Should be at 0s after restart');

  console.log('✓ Control Panel button handlers passed');

  // ─── 3. Test Control Panel Select Menu Handler (gakki:nav_menu) ─────────────
  console.log('Testing Control Panel Song Navigation Select Menu Setting...');
  mockAdapter.simulatedDurationMs = 50000; // at 50s

  const createMockSelectInteraction = (customId: string, value: string) => ({
    guildId,
    customId,
    values: [value],
    reply: async (options: any) => {
      repliedContent = typeof options === 'string' ? options : options.content;
    },
    deferred: false,
    replied: false,
  });

  // Relative forward +30s
  await handleControlPanelSelectMenu(
    createMockSelectInteraction('gakki:nav_menu', 'rel_30') as any,
    playbackManager,
  );
  assert(repliedContent.includes('skipped ahead **+30s**'), 'Should confirm rel_30');
  assert.strictEqual(mockAdapter.lastRebuildSeek, 80, 'Should be at 80s (50+30)');

  // Relative rewind -10s
  mockAdapter.simulatedDurationMs = 80000;
  await handleControlPanelSelectMenu(
    createMockSelectInteraction('gakki:nav_menu', 'rel_-10') as any,
    playbackManager,
  );
  assert(repliedContent.includes('rewound **-10s**'), 'Should confirm rel_-10');
  assert.strictEqual(mockAdapter.lastRebuildSeek, 70, 'Should be at 70s (80-10)');

  // Percentage jump 50% (354s duration -> 177s)
  await handleControlPanelSelectMenu(
    createMockSelectInteraction('gakki:nav_menu', 'pct_50') as any,
    playbackManager,
  );
  assert(repliedContent.includes('jumped to **50%**'), 'Should confirm pct_50');
  assert.strictEqual(mockAdapter.lastRebuildSeek, 177, 'Should be at 177s (50% of 354s)');

  // Restart 0:00
  await handleControlPanelSelectMenu(
    createMockSelectInteraction('gakki:nav_menu', 'abs_0') as any,
    playbackManager,
  );
  assert(repliedContent.includes('restarted from start'), 'Should confirm abs_0');
  assert.strictEqual(mockAdapter.lastRebuildSeek, 0, 'Should be at 0s');

  console.log('✓ Control Panel Song Navigation select menu passed');

  // ─── 4. Test REST API POST /api/playback/:guildId/seek ────────────────────
  console.log('Testing REST API POST /api/playback/:guildId/seek...');

  const app = express();
  app.use(express.json());
  app.use('/api/playback', playbackRoutes(playbackManager));

  mockAdapter.simulatedDurationMs = 40000;

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // Relative seek via API
    const apiRes1 = await fetch(`${baseUrl}/api/playback/${guildId}/seek`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seconds: 30, relative: true }),
    });
    const body1 = (await apiRes1.json()) as any;

    assert.strictEqual(apiRes1.status, 200);
    assert.strictEqual(body1.success, true);
    assert.strictEqual(body1.positionSeconds, 70);
    assert.strictEqual(mockAdapter.lastRebuildSeek, 70);

    // Absolute seek via API
    const apiRes2 = await fetch(`${baseUrl}/api/playback/${guildId}/seek`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seconds: 15, relative: false }),
    });
    const body2 = (await apiRes2.json()) as any;

    assert.strictEqual(apiRes2.status, 200);
    assert.strictEqual(body2.success, true);
    assert.strictEqual(body2.positionSeconds, 15);
    assert.strictEqual(mockAdapter.lastRebuildSeek, 15);

    // Invalid payload validation
    const apiRes3 = await fetch(`${baseUrl}/api/playback/${guildId}/seek`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seconds: 'invalid' }),
    });
    assert.strictEqual(apiRes3.status, 400);
  } finally {
    server.close();
  }

  console.log('✓ REST API seek endpoints passed');

  console.log('\n========================================');
  console.log(' ALL NAVIGATION & SEEKING TESTS PASSED!');
  console.log('========================================');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
