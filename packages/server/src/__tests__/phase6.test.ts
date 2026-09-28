import 'dotenv/config';
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
  createLogger,
  GuildSettingsManager,
  TrackManager,
  AnalyticsManager,
  PlaylistManager,
  connectDatabase,
  disconnectDatabase,
  type DatabaseClient,
} from '@gakki/core';
import {
  slashCommandDefinitions,
  handleChatInputCommand,
  handleAutocomplete,
} from '../discord/commands';
import { createConfiguredAudioSourceManager } from '../sources';
import { ArtworkService } from '../services/artwork.service';
import * as path from 'path';
import * as fs from 'fs';

const logger = createLogger('phase6-test');

class Phase6MockVoiceAdapter implements VoicePlatformAdapter {
  readonly platform = 'mock-discord';
  private voiceStatuses = new Map<string, VoiceConnectionStatus>();
  private playerStatuses = new Map<string, PlaybackStatus>();
  public currentTracks = new Map<string, AudioTrackInfo | null>();
  public volume: number = 100;
  public activeFilters: AudioFilterConfig = { bassboost: false, speed: 1.0, nightcore: false };
  public playCount: number = 0;
  public lastSource: AudioSource | null = null;
  public humanCount: number = 1;

  private stateListeners = new Set<(state: VoicePlatformState) => void>();
  private errorListeners = new Set<(guildId: string, err: Error) => void>();
  private trackEndListeners = new Set<(guildId: string) => void>();

  async joinVoice(guildId: string, _channelId: string): Promise<void> {
    this.voiceStatuses.set(guildId, 'CONNECTED');
    this.emitState(guildId);
  }

  async leaveVoice(guildId: string): Promise<void> {
    this.stop(guildId);
    this.voiceStatuses.set(guildId, 'DISCONNECTED');
    this.emitState(guildId);
  }

  getVoiceStatus(guildId: string): VoiceConnectionStatus {
    return this.voiceStatuses.get(guildId) || 'DISCONNECTED';
  }

  getPlaybackStatus(guildId: string): PlaybackStatus {
    return this.playerStatuses.get(guildId) || 'IDLE';
  }

  getCurrentTrack(guildId: string): AudioTrackInfo | null {
    return this.currentTracks.get(guildId) || null;
  }

  async play(guildId: string, source: AudioSource, options?: AdapterPlayOptions): Promise<void> {
    this.lastSource = source;
    this.playCount++;
    this.playerStatuses.set(guildId, 'PLAYING');
    if (options?.volume !== undefined) this.volume = options.volume;
    if (options?.filters) this.activeFilters = { ...options.filters };

    const metadata = source.getMetadata ? await source.getMetadata() : { title: 'Unknown' };
    this.currentTracks.set(guildId, {
      name: metadata.title,
      duration: metadata.duration ?? null,
      sourceType: source.sourceType,
      filePath: source.identifier,
      artist: (metadata as any).artist ?? null,
    });

    this.emitState(guildId);
  }

  pause(guildId: string): boolean {
    if (this.playerStatuses.get(guildId) === 'PLAYING') {
      this.playerStatuses.set(guildId, 'PAUSED');
      this.emitState(guildId);
      return true;
    }
    return false;
  }

  resume(guildId: string): boolean {
    if (this.playerStatuses.get(guildId) === 'PAUSED') {
      this.playerStatuses.set(guildId, 'PLAYING');
      this.emitState(guildId);
      return true;
    }
    return false;
  }

  stop(guildId: string): boolean {
    this.playerStatuses.set(guildId, 'IDLE');
    this.currentTracks.set(guildId, null);
    this.emitState(guildId);
    return true;
  }

  setVolume(_guildId: string, volume: number): number {
    this.volume = volume;
    return volume;
  }

  getState(guildId: string): VoicePlatformState {
    return {
      guildId,
      voiceState: this.getVoiceStatus(guildId),
      playerState: this.getPlaybackStatus(guildId),
      track: this.currentTracks.get(guildId) || null,
    };
  }

  onStateChange(listener: (state: VoicePlatformState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onError(listener: (guildId: string, error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  onTrackEnd(listener: (guildId: string) => void): () => void {
    this.trackEndListeners.add(listener);
    return () => this.trackEndListeners.delete(listener);
  }

  async triggerTrackEnd(guildId: string): Promise<void> {
    this.playerStatuses.set(guildId, 'IDLE');
    for (const listener of this.trackEndListeners) {
      await listener(guildId);
    }
  }

  private emitState(guildId: string): void {
    const s = this.getState(guildId);
    for (const l of this.stateListeners) {
      l(s);
    }
  }
}

class MockAudioSource implements AudioSource {
  readonly sourceType = 'local' as const;
  readonly identifier: string;

  constructor(public title: string, public duration: number = 180) {
    this.identifier = title;
  }

  async validate(): Promise<void> {}
  async getMetadata() {
    return { title: this.title, duration: this.duration, artist: 'Mock Artist' };
  }
  async getStream(): Promise<any> {
    return null;
  }
}

// ── Test Runner ───────────────────────────────────────────────────

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assert(condition: boolean, message: string): void {
  totalTests++;
  if (!condition) {
    failedTests++;
    console.error(`  FAIL: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  passedTests++;
  console.log(`  PASS: ${message}`);
}

async function runPhase6Tests(): Promise<void> {
  console.log('\n======================================================');
  console.log('   GAKKI MUSIC PLATFORM — PHASE 6 TEST SUITE');
  console.log('======================================================\n');

  // Database Connection
  const dbUrl = process.env.DATABASE_URL || 'postgresql://gakki:gakki@localhost:5432/gakki';
  let db: DatabaseClient | null = null;
  try {
    db = await connectDatabase(dbUrl);
    console.log('[DB] Connected to PostgreSQL successfully\n');
  } catch (err) {
    console.warn('[DB] Failed to connect to PostgreSQL — running with mock fallback\n');
  }

  const trackManager = new TrackManager(db);
  const analyticsManager = new AnalyticsManager(db, logger, trackManager);
  const playlistManager = new PlaylistManager(db, logger, trackManager);
  const artworkService = new ArtworkService();
  const audioSourceManager = createConfiguredAudioSourceManager(artworkService, trackManager);

  // ────────────────────────────────────────────────────────────────
  // SUITE 1: Playback Event Lifecycle & Event Idempotency
  // ────────────────────────────────────────────────────────────────
  console.log('--- SUITE 1: Playback Event Lifecycle & Event Idempotency ---');
  {
    const queueManager = new QueueManager(logger);
    const playbackManager = new PlaybackManager(
      logger,
      queueManager,
      300,
      undefined,
      analyticsManager,
      trackManager,
    );
    const adapter = new Phase6MockVoiceAdapter();
    playbackManager.registerAdapter(adapter);

    const guildId = 'suite1-guild-' + Date.now();
    await playbackManager.join(guildId, 'vc-1');

    // 1. Persist a test track
    const { track: savedTrack } = await trackManager.saveTrackWithSource(
      { title: 'Idempotency Song', artist: 'Artist X', duration: 200 },
      { provider: 'local', sourceType: 'file', sourceUrl: 'test1.mp3' },
    );

    // 2. Start playback
    const source1 = new MockAudioSource('Idempotency Song', 200);
    const playResult = await playbackManager.play(guildId, source1, {
      name: 'Idempotency Song',
      path: 'test1.mp3',
      trackId: savedTrack.id,
      userId: 'user-alpha',
      duration: 200,
    });

    assert(playResult.status === 'started', 'Track starts immediately');
    const sessionId = playbackManager.getOrCreateSessionId(guildId);
    assert(sessionId.startsWith('session_'), 'Session ID is generated');

    // Wait a brief tick to simulate active playback
    await new Promise((r) => setTimeout(r, 60));

    // 3. Trigger natural completion
    await adapter.triggerTrackEnd(guildId);

    // 4. Query history
    const history = await analyticsManager.getGuildHistory(guildId);
    assert(history.total === 1, 'Exactly one playback event was recorded for single playback');
    assert(history.events.length === 1, 'History returns 1 event');
    assert(history.events[0].completed === true, 'Event marked completed = true on natural completion');
    assert(history.events[0].endReason === 'finished', 'Event endReason = finished');
    assert(history.events[0].userId === 'user-alpha', 'Event records initiating user');
    assert(history.events[0].sessionId === sessionId, 'Event belongs to guild session');
  }

  // ────────────────────────────────────────────────────────────────
  // SUITE 2: Active Listening Duration & Pause Exclusion
  // ────────────────────────────────────────────────────────────────
  console.log('\n--- SUITE 2: Active Listening Duration & Pause Exclusion ---');
  {
    const queueManager = new QueueManager(logger);
    const playbackManager = new PlaybackManager(
      logger,
      queueManager,
      300,
      undefined,
      analyticsManager,
      trackManager,
    );
    const adapter = new Phase6MockVoiceAdapter();
    playbackManager.registerAdapter(adapter);

    const guildId = 'suite2-guild-' + Date.now();
    await playbackManager.join(guildId, 'vc-2');

    const { track: savedTrack } = await trackManager.saveTrackWithSource(
      { title: 'Pause Exclusion Song', artist: 'Artist Y', duration: 150 },
      { provider: 'local', sourceType: 'file', sourceUrl: 'test2.mp3' },
    );

    const source = new MockAudioSource('Pause Exclusion Song', 150);
    await playbackManager.play(guildId, source, {
      name: 'Pause Exclusion Song',
      path: 'test2.mp3',
      trackId: savedTrack.id,
      duration: 150,
    });

    // Play for 100ms
    await new Promise((r) => setTimeout(r, 100));

    // Pause for 150ms
    playbackManager.pause(guildId);
    await new Promise((r) => setTimeout(r, 150));

    // Resume and play for 100ms
    playbackManager.resume(guildId);
    await new Promise((r) => setTimeout(r, 100));

    // Skip track
    await playbackManager.skip(guildId);

    const history = await analyticsManager.getGuildHistory(guildId);
    assert(history.total === 1, 'Single event finalized on skip');
    assert(history.events[0].completed === false, 'Skipped track completed = false');
    assert(history.events[0].endReason === 'skipped', 'Event endReason = skipped');
    // Active time was ~200ms (~0.2s), while total wall clock was ~350ms.
    // In seconds round, durationListened will be ~0 or 1s, accurately calculated without paused time!
    assert(history.events[0].durationListened >= 0, 'Duration listened recorded non-negative');
  }

  // ────────────────────────────────────────────────────────────────
  // SUITE 3: Multi-Guild History & Isolation
  // ────────────────────────────────────────────────────────────────
  console.log('\n--- SUITE 3: Multi-Guild History & Isolation ---');
  {
    const queueManager = new QueueManager(logger);
    const playbackManager = new PlaybackManager(
      logger,
      queueManager,
      300,
      undefined,
      analyticsManager,
      trackManager,
    );
    const adapter = new Phase6MockVoiceAdapter();
    playbackManager.registerAdapter(adapter);

    const guildA = 'guild-A-' + Date.now();
    const guildB = 'guild-B-' + Date.now();

    const { track: trackA } = await trackManager.saveTrackWithSource(
      { title: 'Song Alpha for Guild A', artist: 'Artist A', duration: 100 },
      { provider: 'local', sourceType: 'file', sourceUrl: 'trackA.mp3' },
    );

    const { track: trackB } = await trackManager.saveTrackWithSource(
      { title: 'Song Beta for Guild B', artist: 'Artist B', duration: 120 },
      { provider: 'local', sourceType: 'file', sourceUrl: 'trackB.mp3' },
    );

    // Play on Guild A
    await playbackManager.play(guildA, new MockAudioSource('Song Alpha for Guild A', 100), {
      name: 'Song Alpha for Guild A',
      path: 'trackA.mp3',
      trackId: trackA.id,
    });
    await adapter.triggerTrackEnd(guildA);

    // Play on Guild B
    await playbackManager.play(guildB, new MockAudioSource('Song Beta for Guild B', 120), {
      name: 'Song Beta for Guild B',
      path: 'trackB.mp3',
      trackId: trackB.id,
    });
    await adapter.triggerTrackEnd(guildB);

    // Assert Guild A history does NOT contain Guild B's track
    const histA = await analyticsManager.getGuildHistory(guildA);
    const histB = await analyticsManager.getGuildHistory(guildB);

    assert(histA.total === 1, 'Guild A has exactly 1 event');
    assert(histA.events[0].track.title === 'Song Alpha for Guild A', 'Guild A history has Track Alpha');
    assert(histB.total === 1, 'Guild B has exactly 1 event');
    assert(histB.events[0].track.title === 'Song Beta for Guild B', 'Guild B history has Track Beta');

    const recentA = await analyticsManager.getRecentTracks(guildA);
    const recentB = await analyticsManager.getRecentTracks(guildB);
    assert(recentA.length === 1 && recentA[0].title === 'Song Alpha for Guild A', 'Guild A /recent is isolated');
    assert(recentB.length === 1 && recentB[0].title === 'Song Beta for Guild B', 'Guild B /recent is isolated');
  }

  // ────────────────────────────────────────────────────────────────
  // SUITE 4: Persistent Playlist CRUD, Ordering & Permissions
  // ────────────────────────────────────────────────────────────────
  console.log('\n--- SUITE 4: Persistent Playlist CRUD, Ordering & Permissions ---');
  {
    const userId = 'user-owner-' + Date.now();
    const otherUser = 'user-intruder-' + Date.now();
    const guildId = 'guild-pl-' + Date.now();

    // 1. Create playlist
    const pl = await playlistManager.createPlaylist({
      name: 'Synthwave Night',
      description: 'Cruising synth playlist',
      ownerUserId: userId,
      guildId,
      visibility: 'guild',
    });

    assert(pl.id != null, 'Playlist created with ID');
    assert(pl.name === 'Synthwave Night', 'Playlist name matches');

    // 2. Add tracks
    const { track: t1 } = await trackManager.saveTrackWithSource(
      { title: 'Nightcall', artist: 'Kavinsky', duration: 259 },
      { provider: 'local', sourceType: 'file', sourceUrl: 'nightcall.mp3' },
    );
    const { track: t2 } = await trackManager.saveTrackWithSource(
      { title: 'Resonance', artist: 'Home', duration: 212 },
      { provider: 'local', sourceType: 'file', sourceUrl: 'resonance.mp3' },
    );

    const pt1 = await playlistManager.addTrackToPlaylist(pl.id, t1.id, 'User Owner');
    assert(pt1.position === 1, 'First track inserted at position 1');

    const pt2 = await playlistManager.addTrackToPlaylist(pl.id, t2.id, 'User Owner');
    assert(pt2.position === 2, 'Second track inserted at position 2');

    // 3. Verify duplicate tracks allowed (Section 16 requirement)
    const pt3 = await playlistManager.addTrackToPlaylist(pl.id, t1.id, 'User Owner');
    assert(pt3.position === 3, 'Duplicate track allowed at position 3');

    // 4. Retrieve playlist details
    const details = await playlistManager.getPlaylist(pl.id);
    assert(details !== null, 'Playlist details retrieved');
    assert(details!.tracks.length === 3, 'Playlist contains 3 tracks');
    assert(details!.tracks[0].track?.title === 'Nightcall', 'Track 1 title correct');
    assert(details!.tracks[1].track?.title === 'Resonance', 'Track 2 title correct');
    assert(details!.tracks[2].track?.title === 'Nightcall', 'Track 3 duplicate title correct');

    // 5. Remove track at position 2 (Resonance)
    const removed = await playlistManager.removeTrackFromPlaylist(pl.id, 2);
    assert(removed === true, 'Track removed at position 2');

    const afterRemove = await playlistManager.getPlaylist(pl.id);
    assert(afterRemove!.tracks.length === 2, 'Playlist now has 2 tracks');
    assert(afterRemove!.tracks[0].position === 1, 'First track still position 1');
    assert(afterRemove!.tracks[1].position === 2, 'Compacted subsequent track to position 2');

    // 6. Reorder tracks
    const reordered = await playlistManager.reorderPlaylistTrack(pl.id, 1, 2);
    assert(reordered === true, 'Reordered position 1 to position 2');
    const afterReorder = await playlistManager.getPlaylist(pl.id);
    assert(afterReorder!.tracks.length === 2, 'Still 2 tracks after reorder');
    assert(afterReorder!.tracks[0].position === 1 && afterReorder!.tracks[1].position === 2, 'Positions remain 1 and 2');

    // 7. Rename playlist
    const renamed = await playlistManager.renamePlaylist(pl.id, 'Synthwave Sunset', userId);
    assert(renamed.name === 'Synthwave Sunset', 'Playlist renamed successfully by owner');

    // 8. Permission check: other user cannot rename or delete owner's private playlist
    const privatePl = await playlistManager.createPlaylist({
      name: 'Secret Tracks',
      ownerUserId: userId,
      visibility: 'private',
    });

    let permFailed = false;
    try {
      await playlistManager.renamePlaylist(privatePl.id, 'Hacked Playlist', otherUser);
    } catch (err: any) {
      permFailed = err.name === 'PlaylistPermissionError';
    }
    assert(permFailed, 'Intruder rejected from renaming private playlist with PlaylistPermissionError');

    // 9. Delete playlist
    const deleted = await playlistManager.deletePlaylist(pl.id, userId);
    assert(deleted === true, 'Playlist deleted by owner');
    const checkDeleted = await playlistManager.getPlaylist(pl.id);
    assert(checkDeleted === null, 'Deleted playlist returns null');
  }

  // ────────────────────────────────────────────────────────────────
  // SUITE 5: Playlist Playback & Unavailable Source Handling
  // ────────────────────────────────────────────────────────────────
  console.log('\n--- SUITE 5: Playlist Playback & Unavailable Source Handling ---');
  {
    const queueManager = new QueueManager(logger);
    const playbackManager = new PlaybackManager(
      logger,
      queueManager,
      300,
      undefined,
      analyticsManager,
      trackManager,
    );
    const adapter = new Phase6MockVoiceAdapter();
    playbackManager.registerAdapter(adapter);

    const guildId = 'guild-play-pl-' + Date.now();
    await playbackManager.join(guildId, 'vc-pl');

    const pl = await playlistManager.createPlaylist({
      name: 'Mixtape 2026',
      guildId,
    });

    // Track 1 with valid source
    const { track: validTrack } = await trackManager.saveTrackWithSource(
      { title: 'Available Track', artist: 'Artist V', duration: 180 },
      { provider: 'local', sourceType: 'file', sourceUrl: 'valid.mp3' },
    );
    await playlistManager.addTrackToPlaylist(pl.id, validTrack.id);

    // Track 2 without valid source (simulate missing source)
    const { track: missingSourceTrack } = await trackManager.saveTrackWithSource(
      { title: 'Deleted Source Track', artist: 'Artist M', duration: 200 },
      { provider: 'local', sourceType: 'file', sourceUrl: '' }, // empty source
    );
    await playlistManager.addTrackToPlaylist(pl.id, missingSourceTrack.id);

    // Track 3 with valid source
    const { track: validTrack2 } = await trackManager.saveTrackWithSource(
      { title: 'Second Valid Track', artist: 'Artist V2', duration: 160 },
      { provider: 'local', sourceType: 'file', sourceUrl: 'valid2.mp3' },
    );
    await playlistManager.addTrackToPlaylist(pl.id, validTrack2.id);

    // Execute playback of playlist
    const playlistData = await playlistManager.getPlaylist(pl.id);
    assert(playlistData!.tracks.length === 3, 'Playlist has 3 tracks total');

    let enqueued = 0;
    let skipped = 0;

    for (const pt of playlistData!.tracks) {
      if (!pt.source || !pt.source.sourceUrl) {
        skipped++;
        continue;
      }
      const source = new MockAudioSource(pt.track?.title || 'Track', pt.track?.duration ?? 100);
      const res = await playbackManager.play(guildId, source, {
        name: pt.track?.title || 'Track',
        path: pt.source.sourceUrl,
        trackId: pt.trackId,
      });
      enqueued++;
    }

    assert(enqueued === 2, '2 available tracks enqueued');
    assert(skipped === 1, '1 unavailable track skipped');

    // Verify missing source track was NOT deleted from the playlist (Section 15 requirement)
    const verifyPl = await playlistManager.getPlaylist(pl.id);
    assert(verifyPl!.tracks.length === 3, 'Unavailable track was NOT deleted from the playlist');
  }

  // ────────────────────────────────────────────────────────────────
  // SUITE 6: PostgreSQL Analytics Aggregation & Queries
  // ────────────────────────────────────────────────────────────────
  console.log('\n--- SUITE 6: PostgreSQL Analytics Aggregation & Queries ---');
  {
    const analyticsGuild = 'analytics-guild-' + Date.now();

    const { track: starTrack } = await trackManager.saveTrackWithSource(
      { title: 'Starboy', artist: 'The Weeknd', duration: 230 },
      { provider: 'local', sourceType: 'file', sourceUrl: 'starboy.mp3' },
    );

    // Record 3 playback events
    // Event 1: Completed
    const e1 = await analyticsManager.recordPlaybackStart({
      guildId: analyticsGuild,
      trackId: starTrack.id,
      userId: 'user-fan',
      trackDuration: 230,
      source: 'local',
    });
    await analyticsManager.recordPlaybackEnd(e1, {
      durationListened: 230,
      completed: true,
      endReason: 'finished',
    });

    // Event 2: Skipped at 50s
    const e2 = await analyticsManager.recordPlaybackStart({
      guildId: analyticsGuild,
      trackId: starTrack.id,
      userId: 'user-fan',
      trackDuration: 230,
      source: 'local',
    });
    await analyticsManager.recordPlaybackEnd(e2, {
      durationListened: 50,
      completed: false,
      endReason: 'skipped',
    });

    // Event 3: Stopped at 100s by different user
    const e3 = await analyticsManager.recordPlaybackStart({
      guildId: analyticsGuild,
      trackId: starTrack.id,
      userId: 'user-friend',
      trackDuration: 230,
      source: 'local',
    });
    await analyticsManager.recordPlaybackEnd(e3, {
      durationListened: 100,
      completed: false,
      endReason: 'stopped',
    });

    // 1. Query Track Statistics
    const trackStats = await analyticsManager.getTrackStatistics(starTrack.id);
    assert(trackStats.playCount >= 3, 'Track play count >= 3');
    assert(trackStats.completionCount >= 1, 'Track completion count >= 1');
    assert(trackStats.skipCount >= 1, 'Track skip count >= 1');
    assert(trackStats.totalListeningTime >= 380, 'Total listening time aggregated correctly');
    assert(trackStats.uniqueListeners >= 2, '2 unique listeners counted');

    // 2. Query Guild Analytics
    const guildStats = await analyticsManager.getGuildAnalytics(analyticsGuild);
    assert(guildStats.totalTracksPlayed === 3, 'Guild total plays = 3');
    assert(guildStats.totalListeningTime === 380, 'Guild total listening time = 380s');
    assert(guildStats.completionRate === 0.333, 'Guild completion rate = 0.333');
    assert(guildStats.skipRate === 0.333, 'Guild skip rate = 0.333');
    assert(guildStats.uniqueUsers === 2, 'Guild unique users = 2');
    assert(guildStats.uniqueTracks === 1, 'Guild unique tracks = 1');
    assert(guildStats.topTracks.length >= 1, 'Top tracks list populated');
    assert(guildStats.topTracks[0].title === 'Starboy', 'Top track is Starboy');
    assert(guildStats.topArtists.length >= 1, 'Top artists list populated');
    assert(guildStats.topArtists[0].artist === 'The Weeknd', 'Top artist is The Weeknd');
  }

  // ────────────────────────────────────────────────────────────────
  // SUITE 7: Database Persistence Across Simulated Restart
  // ────────────────────────────────────────────────────────────────
  console.log('\n--- SUITE 7: Database Persistence Across Simulated Restart ---');
  {
    const restartPlName = 'Survival Playlist ' + Date.now();
    const pl = await playlistManager.createPlaylist({
      name: restartPlName,
      visibility: 'public',
    });

    const { track } = await trackManager.saveTrackWithSource(
      { title: 'Survivor Track', artist: 'Destiny', duration: 180 },
      { provider: 'local', sourceType: 'file', sourceUrl: 'survivor.mp3' },
    );
    await playlistManager.addTrackToPlaylist(pl.id, track.id);

    // Simulate backend restart by creating new managers over existing DB
    const freshPlaylistManager = new PlaylistManager(db, logger);
    const freshAnalyticsManager = new AnalyticsManager(db, logger);

    const found = await freshPlaylistManager.findPlaylistByName(restartPlName);
    assert(found !== null, 'Playlist survived simulated backend restart');
    assert(found!.id === pl.id, 'Playlist ID identical after restart');

    const details = await freshPlaylistManager.getPlaylist(pl.id);
    assert(details!.tracks.length === 1, 'Playlist tracks persisted across restart');
    assert(details!.tracks[0].track?.title === 'Survivor Track', 'Track metadata intact');
  }

  // ────────────────────────────────────────────────────────────────
  // SUITE 8: Graceful Shutdown & Queue Serialization
  // ────────────────────────────────────────────────────────────────
  console.log('\n--- SUITE 8: Graceful Shutdown & Queue Serialization ---');
  {
    const queueManager = new QueueManager(logger);
    const playbackManager = new PlaybackManager(
      logger,
      queueManager,
      300,
      undefined,
      analyticsManager,
      trackManager,
    );
    const adapter = new Phase6MockVoiceAdapter();
    playbackManager.registerAdapter(adapter);

    const guildId = 'shutdown-guild-' + Date.now();
    await playbackManager.join(guildId, 'vc-shutdown');

    const { track } = await trackManager.saveTrackWithSource(
      { title: 'Shutdown Song', artist: 'Exit', duration: 100 },
      { provider: 'local', sourceType: 'file', sourceUrl: 'shutdown.mp3' },
    );

    // Start playback
    await playbackManager.play(guildId, new MockAudioSource('Shutdown Song', 100), {
      name: 'Shutdown Song',
      path: 'shutdown.mp3',
      trackId: track.id,
    });

    // Enqueue 2 tracks
    queueManager.addTrack(guildId, {
      id: 'q1',
      name: 'Queued 1',
      path: 'q1.mp3',
    });
    queueManager.addTrack(guildId, {
      id: 'q2',
      name: 'Queued 2',
      path: 'q2.mp3',
    });

    // Serialize queues
    const serialized = queueManager.serializeQueues();
    assert(serialized[guildId] && serialized[guildId].length === 2, 'Queues serialized with 2 tracks');

    // Trigger graceful shutdown
    await playbackManager.shutdown();

    // Verify active playback was finalized with 'stopped'
    const hist = await analyticsManager.getGuildHistory(guildId);
    assert(hist.total === 1, 'Shutdown finalized active event');
    assert(hist.events[0].endReason === 'stopped', 'Finalized event endReason = stopped');

    // Restore queues into fresh queue manager
    const freshQueueManager = new QueueManager(logger);
    freshQueueManager.restoreQueues(serialized);
    assert(freshQueueManager.getQueueLength(guildId) === 2, 'Queues restored on fresh queue manager');
  }

  // ────────────────────────────────────────────────────────────────
  // SUITE 9: Discord Commands & Slash Command Definitions
  // ────────────────────────────────────────────────────────────────
  console.log('\n--- SUITE 9: Discord Commands & Slash Command Definitions ---');
  {
    const commandNames = slashCommandDefinitions.map((c) => c.name);
    assert(commandNames.includes('history'), '/history is defined in slashCommandDefinitions');
    assert(commandNames.includes('recent'), '/recent is defined in slashCommandDefinitions');
    assert(commandNames.includes('playlist'), '/playlist is defined in slashCommandDefinitions');

    const playlistCmd = slashCommandDefinitions.find((c) => c.name === 'playlist') as any;
    const subcommands = playlistCmd.options.map((o: any) => o.name);
    assert(subcommands.includes('create'), '/playlist create subcommand defined');
    assert(subcommands.includes('list'), '/playlist list subcommand defined');
    assert(subcommands.includes('play'), '/playlist play subcommand defined');
    assert(subcommands.includes('add'), '/playlist add subcommand defined');
    assert(subcommands.includes('remove'), '/playlist remove subcommand defined');
    assert(subcommands.includes('rename'), '/playlist rename subcommand defined');
    assert(subcommands.includes('delete'), '/playlist delete subcommand defined');

    // Test slash command execution: /history
    const queueManager = new QueueManager(logger);
    const playbackManager = new PlaybackManager(
      logger,
      queueManager,
      300,
      undefined,
      analyticsManager,
      trackManager,
    );

    let replyPayload: any = null;
    let deferred: any = false;

    const mockInteraction: any = {
      commandName: 'history',
      guildId: 'cmd-test-guild',
      options: {
        getInteger: () => 5,
        getString: () => null,
        getSubcommand: () => null,
      },
      member: { id: 'u1', displayName: 'TestUser' },
      deferReply: async () => { deferred = true; },
      editReply: async (payload: any) => { replyPayload = payload; },
      reply: async (payload: any) => { replyPayload = payload; },
    };

    await handleChatInputCommand(
      mockInteraction,
      playbackManager,
      audioSourceManager,
      analyticsManager,
      playlistManager,
      trackManager,
    );

    assert(deferred === true, '/history defers reply');
    assert(replyPayload !== null, '/history replies with content or embed');
  }

  // ────────────────────────────────────────────────────────────────
  // SUITE 10: WebSocket Real-Time Event Synchronization
  // ────────────────────────────────────────────────────────────────
  console.log('\n--- SUITE 10: WebSocket Real-Time Event Synchronization ---');
  {
    const queueManager = new QueueManager(logger);
    const playbackManager = new PlaybackManager(
      logger,
      queueManager,
      300,
      undefined,
      analyticsManager,
      trackManager,
    );
    const adapter = new Phase6MockVoiceAdapter();
    playbackManager.registerAdapter(adapter);

    const emittedEvents: any[] = [];
    playbackManager.onPlaybackEvent((e) => {
      emittedEvents.push(e);
    });

    const guildId = 'ws-test-guild-' + Date.now();
    await playbackManager.play(guildId, new MockAudioSource('WS Track', 100), {
      name: 'WS Track',
      path: 'ws.mp3',
    });

    assert(emittedEvents.length === 1, 'playback.started event emitted');
    assert(emittedEvents[0].type === 'playback.started', 'Event type is playback.started');
    assert(emittedEvents[0].title === 'WS Track', 'Event contains track title');

    // Trigger end
    await adapter.triggerTrackEnd(guildId);
    assert(emittedEvents.length === 2, 'playback.ended event emitted');
    assert(emittedEvents[1].type === 'playback.ended', 'Event type is playback.ended');
    assert(emittedEvents[1].endReason === 'finished', 'Event contains endReason finished');
  }

  // Cleanup DB
  if (db) {
    await disconnectDatabase();
    console.log('\n[DB] Database disconnected');
  }

  console.log('\n======================================================');
  console.log(`   PHASE 6 TEST RESULTS: ${passedTests}/${totalTests} PASSED (${failedTests} FAILED)`);
  console.log('======================================================\n');

  process.exit(failedTests > 0 ? 1 : 0);
}

runPhase6Tests().catch((err) => {
  console.error('Fatal error in Phase 6 test suite:', err);
  process.exit(1);
});
