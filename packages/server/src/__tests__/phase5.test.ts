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
  AudioSourceManager,
  connectDatabase,
  disconnectDatabase,
} from '@gakki/core';
import { validateExternalUrl, isPrivateOrReservedIp, SecurityUrlValidationError } from '../security/url-validator';
import { RateLimiter } from '../security/rate-limiter';
import { AudioCache } from '../audio/audio-cache';
import { YouTubeSourceProvider, ProviderPolicyRestrictionError } from '../sources/youtube.provider';
import { HttpStreamProvider } from '../sources/http-stream.provider';
import { LocalSourceProvider } from '../sources/local-source.provider';
import { SoundCloudSourceProvider } from '../sources/soundcloud.provider';
import { ArtworkService } from '../services/artwork.service';
import { RemoteStreamManager } from '../audio/remote-stream';
import * as path from 'path';
import * as fs from 'fs';

const logger = createLogger('phase5-test');

class Phase5MockVoiceAdapter implements VoicePlatformAdapter {
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

  getState(guildId: string): VoicePlatformState {
    return {
      guildId,
      voiceState: this.getVoiceStatus(guildId),
      playerState: this.getPlaybackStatus(guildId),
      track: this.currentTracks.get(guildId) || null,
    };
  }

  async play(guildId: string, source: AudioSource, options?: AdapterPlayOptions): Promise<void> {
    this.playCount++;
    this.lastSource = source;
    this.playerStatuses.set(guildId, 'PLAYING');
    const meta = await source.getMetadata();
    const track: AudioTrackInfo = {
      name: meta.title,
      duration: meta.duration ?? 180,
      sourceType: source.sourceType,
      filePath: source.identifier,
    };
    this.currentTracks.set(guildId, track);
    if (options?.volume !== undefined) this.volume = options.volume;
    if (options?.filters) this.activeFilters = options.filters;
    this.emitState(guildId);
  }

  pause(guildId: string): boolean {
    if (this.getPlaybackStatus(guildId) === 'PLAYING') {
      this.playerStatuses.set(guildId, 'PAUSED');
      this.emitState(guildId);
      return true;
    }
    return false;
  }

  resume(guildId: string): boolean {
    if (this.getPlaybackStatus(guildId) === 'PAUSED') {
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

  setVolume(_guildId: string, volume: number): void {
    this.volume = volume;
  }

  async rebuildCurrentStream(
    guildId: string,
    filters: AudioFilterConfig,
    _seekSeconds?: number,
  ): Promise<void> {
    this.activeFilters = filters;
    this.emitState(guildId);
  }

  getPlaybackDuration(_guildId: string): number {
    return 10000;
  }

  getHumanUserCount(_guildId: string): number {
    return this.humanCount;
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

  simulateTrackEnd(guildId: string) {
    for (const listener of this.trackEndListeners) {
      listener(guildId);
    }
  }

  private emitState(guildId: string) {
    const state: VoicePlatformState = {
      guildId,
      voiceState: this.getVoiceStatus(guildId),
      playerState: this.getPlaybackStatus(guildId),
      track: this.currentTracks.get(guildId) || null,
    };
    for (const listener of this.stateListeners) {
      listener(state);
    }
  }
}

async function runPhase5TestSuite() {
  console.log('\n============================================================');
  console.log('🧪 RUNNING GAKKI PHASE 5 COMPREHENSIVE VERIFICATION SUITE');
  console.log('============================================================\n');

  let passedTests = 0;
  let totalTests = 0;

  function assert(condition: boolean, testName: string, details?: string) {
    totalTests++;
    if (condition) {
      console.log(`  ✅ [PASS] ${testName}`);
      passedTests++;
    } else {
      console.error(`  ❌ [FAIL] ${testName}${details ? ` - ${details}` : ''}`);
      throw new Error(`Test failed: ${testName} - ${details ?? ''}`);
    }
  }

  const testMusicDir = path.resolve(__dirname, 'test_media_phase5');
  if (!fs.existsSync(testMusicDir)) {
    fs.mkdirSync(testMusicDir, { recursive: true });
  }
  const testTrack1 = path.join(testMusicDir, 'test_song_1.mp3');
  const testTrack2 = path.join(testMusicDir, 'synthwave_afterdark.mp3');
  fs.writeFileSync(testTrack1, Buffer.from('FAKE MP3 HEADER DATA 1'));
  fs.writeFileSync(testTrack2, Buffer.from('FAKE MP3 HEADER DATA 2'));

  const testCacheDir = path.resolve(__dirname, 'test_audio_cache');

  try {
    // -----------------------------------------------------------------
    // 1. SECURITY & SSRF VALIDATION
    // -----------------------------------------------------------------
    console.log('\n--- 1. Security & SSRF Protection ---');

    assert(isPrivateOrReservedIp('127.0.0.1'), 'Blocks 127.0.0.1 (IPv4 loopback)');
    assert(isPrivateOrReservedIp('127.255.255.255'), 'Blocks 127.x.x.x loopback range');
    assert(isPrivateOrReservedIp('10.0.1.50'), 'Blocks 10.0.0.0/8 private network');
    assert(isPrivateOrReservedIp('172.16.5.10'), 'Blocks 172.16.0.0/12 private network');
    assert(isPrivateOrReservedIp('192.168.1.1'), 'Blocks 192.168.0.0/16 private network');
    assert(isPrivateOrReservedIp('169.254.169.254'), 'Blocks AWS/Cloud metadata service IP');
    assert(isPrivateOrReservedIp('::1'), 'Blocks ::1 (IPv6 loopback)');
    assert(!isPrivateOrReservedIp('93.184.216.34'), 'Permits public Internet IPv4 (e.g. example.com)');

    let loopbackBlocked = false;
    try {
      validateExternalUrl('http://127.0.0.1:8080/stream');
    } catch (err: any) {
      loopbackBlocked = err instanceof SecurityUrlValidationError;
    }
    assert(loopbackBlocked, 'validateExternalUrl rejects loopback URL');

    let metaBlocked = false;
    try {
      validateExternalUrl('http://169.254.169.254/latest/meta-data/');
    } catch (err: any) {
      metaBlocked = err instanceof SecurityUrlValidationError;
    }
    assert(metaBlocked, 'validateExternalUrl rejects Cloud metadata IP');

    let fileBlocked = false;
    try {
      validateExternalUrl('file:///etc/passwd');
    } catch (err: any) {
      fileBlocked = err instanceof SecurityUrlValidationError;
    }
    assert(fileBlocked, 'validateExternalUrl rejects non-http file:// schema');

    let validUrlAllowed = false;
    try {
      const parsed = validateExternalUrl('https://icecast.somafm.com/groovesalad-128-mp3');
      validUrlAllowed = parsed.hostname === 'icecast.somafm.com';
    } catch {
      validUrlAllowed = false;
    }
    assert(validUrlAllowed, 'validateExternalUrl permits legitimate public streaming server');

    // -----------------------------------------------------------------
    // 2. RATE LIMITING (Per-User and Per-Guild)
    // -----------------------------------------------------------------
    console.log('\n--- 2. Sliding Window Rate Limiting ---');

    const limiter = new RateLimiter(
      { windowMs: 1000, maxRequests: 3 },
      { windowMs: 1000, maxRequests: 5 },
    );

    const userA = 'user:1001';
    const guildA = 'guild:5001';

    assert(limiter.check(userA).allowed, 'User A request 1 allowed');
    assert(limiter.check(userA).allowed, 'User A request 2 allowed');
    assert(limiter.check(userA).allowed, 'User A request 3 allowed');
    const userABlocked = limiter.check(userA);
    assert(!userABlocked.allowed && userABlocked.retryAfterMs > 0, 'User A request 4 rejected by user rate limit');

    // Guild limit
    assert(limiter.check(guildA).allowed, 'Guild A request 1 allowed');
    assert(limiter.check(guildA).allowed, 'Guild A request 2 allowed');
    assert(limiter.check(guildA).allowed, 'Guild A request 3 allowed');
    assert(limiter.check(guildA).allowed, 'Guild A request 4 allowed');
    assert(limiter.check(guildA).allowed, 'Guild A request 5 allowed');
    const guildBlocked = limiter.check(guildA);
    assert(!guildBlocked.allowed && guildBlocked.retryAfterMs > 0, 'Guild A request 6 rejected by guild rate limit');

    // -----------------------------------------------------------------
    // 3. AUDIO CACHE (Bounded Size, TTL, Request Deduplication, Ephemeral)
    // -----------------------------------------------------------------
    console.log('\n--- 3. Bounded Audio Cache & Request Deduplication ---');

    const cache = new AudioCache({
      storageDir: testCacheDir,
      maxSizeMb: 5,
      ttlSeconds: 2, // 2 second TTL for test
      enabled: true,
    });

    const streamKey = 'stream_test_key_1';
    let downloaderInvocations = 0;

    const mockLoader = async (destPath: string) => {
      downloaderInvocations++;
      await new Promise((r) => setTimeout(r, 60)); // simulate 60ms buffering
      fs.writeFileSync(destPath, Buffer.from('STREAM AUDIO BUFFER PAYLOAD'));
      return { sizeBytes: 27, extension: '.mp3' };
    };

    // First request: MISS -> downloads
    const cached1 = await cache.getOrFetch(streamKey, mockLoader, { persistent: true });
    assert(fs.existsSync(cached1.filePath), 'Cache entry created on filesystem');
    assert(downloaderInvocations === 1, 'First fetch invoked loader once (MISS)');
    assert(cached1.state === 'READY', 'Cache entry state is READY');

    // Second request: HIT
    const cached2 = await cache.getOrFetch(streamKey, mockLoader, { persistent: true });
    assert(cached2.filePath === cached1.filePath, 'Second request returns same cached file (HIT)');
    assert(downloaderInvocations === 1, 'Second request did not re-download (HIT)');

    // Request deduplication test: simultaneous concurrent requests
    downloaderInvocations = 0;
    const streamKey2 = 'stream_concurrent_test_key';
    const [resA, resB] = await Promise.all([
      cache.getOrFetch(streamKey2, mockLoader, { persistent: true }),
      cache.getOrFetch(streamKey2, mockLoader, { persistent: true }),
    ]);
    assert(resA.filePath === resB.filePath, 'Concurrent requests resolve to identical file path');
    assert(downloaderInvocations === 1, 'Concurrent requests deduplicated into single download');

    // Ephemeral cache test
    const ephemeralKey = 'stream_ephemeral_test_key';
    const ephemeralRes = await cache.getOrFetch(ephemeralKey, mockLoader, { persistent: false });
    assert(fs.existsSync(ephemeralRes.filePath), 'Ephemeral file buffered on filesystem');
    assert(ephemeralRes.persistent === false, 'Ephemeral entry marked persistent = false');
    cache.cleanupEphemeral(ephemeralKey);
    assert(!fs.existsSync(ephemeralRes.filePath), 'cleanupEphemeral successfully removed temporary file');

    // -----------------------------------------------------------------
    // 4. SOURCE PROVIDERS & COMPLIANCE POLICIES
    // -----------------------------------------------------------------
    console.log('\n--- 4. Provider Architecture & Policy Compliance ---');

    // YouTube Source Provider: Policy Enforcement
    const ytProvider = new YouTubeSourceProvider();
    assert(ytProvider.canHandle('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'YouTube provider recognizes youtube.com URL');
    assert(ytProvider.canHandle('https://youtu.be/dQw4w9WgXcQ'), 'YouTube provider recognizes youtu.be URL');

    let ytPolicyRefusalThrown = false;
    try {
      await ytProvider.resolve('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    } catch (err: any) {
      if (err instanceof ProviderPolicyRestrictionError && err.message.includes('Terms of Service')) {
        ytPolicyRefusalThrown = true;
      }
    }
    assert(ytPolicyRefusalThrown, 'YouTube provider refuses download per Terms of Service without circumvention');

    // Local Source Provider
    const localProvider = new LocalSourceProvider(undefined, testMusicDir);
    assert(localProvider.canHandle(testTrack1), 'Local provider canHandle absolute local file path');
    assert(localProvider.canHandle('test_song_1.mp3'), 'Local provider canHandle filename in music storage');
    assert(!localProvider.canHandle('https://somafm.com'), 'Local provider ignores external HTTP URLs');

    const resolvedLocal = await localProvider.resolve('synthwave_afterdark.mp3');
    assert(resolvedLocal.source.provider === 'local', 'Local provider resolves track with provider = local');
    assert(resolvedLocal.source.sourceType === 'file', 'Local provider resolves track with sourceType = file');
    assert(resolvedLocal.title.includes('synthwave_afterdark'), 'Local provider normalizes track title');

    // Local search provider
    const searchResults = await localProvider.search('afterdark');
    assert(searchResults.length >= 1, 'Local provider search finds matching tracks');
    assert(searchResults[0].provider === 'local', 'Search result has provider = local');

    // HTTP Stream Provider
    const httpProvider = new HttpStreamProvider();
    assert(httpProvider.canHandle('https://somafm.com/groovesalad.mp3'), 'HTTP provider canHandle audio stream URL');
    assert(!httpProvider.canHandle('https://www.youtube.com/watch?v=123'), 'HTTP provider ignores youtube.com URL');
    assert(!httpProvider.canHandle('https://soundcloud.com/user/track'), 'HTTP provider ignores soundcloud.com URL');

    // SoundCloud Provider
    const scProvider = new SoundCloudSourceProvider();
    assert(scProvider.canHandle('https://soundcloud.com/artist/song-title'), 'SoundCloud provider canHandle track URL');
    assert(!scProvider.canHandle('https://open.spotify.com/track/123'), 'SoundCloud provider ignores non-SoundCloud URL');

    // AudioSourceManager Orchestration
    const audioSourceManager = new AudioSourceManager();
    audioSourceManager.registerProvider(localProvider);
    audioSourceManager.registerProvider(httpProvider);
    audioSourceManager.registerProvider(scProvider);
    audioSourceManager.registerProvider(ytProvider);
    audioSourceManager.registerSearchProvider(localProvider);

    const searchFromManager = await audioSourceManager.search('afterdark');
    assert(searchFromManager.length >= 1, 'AudioSourceManager search aggregates results from providers');

    const resolvedFromManager = await audioSourceManager.resolve('test_song_1.mp3');
    assert(resolvedFromManager.source.provider === 'local', 'AudioSourceManager resolves local track through local provider');

    // -----------------------------------------------------------------
    // 5. POSTGRESQL PERSISTENT GUILD SETTINGS
    // -----------------------------------------------------------------
    console.log('\n--- 5. PostgreSQL Persistent Guild Settings ---');

    const dbUrl = process.env.DATABASE_URL || 'postgresql://gakki:gakki@localhost:5432/gakki';
    const db = await connectDatabase(dbUrl);
    const settingsManager = new GuildSettingsManager(db);

    const testGuildA = 'guild_test_persisted_A';
    const testGuildB = 'guild_test_persisted_B';

    // Update settings for Guild A
    await settingsManager.saveSettings({
      guildId: testGuildA,
      volume: 85,
      filters: {
        bassboost: true,
        speed: 1.25,
        nightcore: true,
      },
      loopMode: 'track',
      stayInChannel: true,
      voiceIdleTimeout: 45,
    });

    // Verify initial load
    const loadedA = await settingsManager.getSettings(testGuildA);
    assert(loadedA.volume === 85, 'Guild A persisted volume is 85');
    assert(loadedA.filters.bassboost === true, 'Guild A persisted bassboost is true');
    assert(loadedA.filters.speed === 1.25, 'Guild A persisted speed is 1.25');
    assert(loadedA.filters.nightcore === true, 'Guild A persisted nightcore is true');
    assert(loadedA.loopMode === 'track', 'Guild A persisted loopMode is track');
    assert(loadedA.stayInChannel === true, 'Guild A persisted stayInChannel is true');

    // Multi-guild isolation check
    const loadedB = await settingsManager.getSettings(testGuildB);
    assert(loadedB.volume === 100, 'Guild B has default volume 100 (isolated from Guild A)');
    assert(loadedB.filters.bassboost === false, 'Guild B has default bassboost false');
    assert(loadedB.loopMode === 'off', 'Guild B has default loopMode off');

    // Simulate backend restart: create new SettingsManager & PlaybackManager instances
    console.log('  Simulating backend restart and cold cache hydration from PostgreSQL...');
    const freshSettingsManager = new GuildSettingsManager(db);
    const freshPlaybackManager = new PlaybackManager(
      logger,
      new QueueManager(logger),
      300,
      freshSettingsManager,
    );
    freshPlaybackManager.registerAdapter(new Phase5MockVoiceAdapter());

    // Allow asynchronous preloading from PostgreSQL or explicitly load
    await freshPlaybackManager.loadGuildSettings(testGuildA);

    const stateAAfterRestart = freshPlaybackManager.getGuildState(testGuildA);
    assert(stateAAfterRestart.volume === 85, 'Guild A volume survived restart (loaded from PostgreSQL)');
    assert(stateAAfterRestart.filters.bassboost === true, 'Guild A bassboost survived restart');
    assert(stateAAfterRestart.filters.speed === 1.25, 'Guild A speed survived restart');
    assert(stateAAfterRestart.filters.nightcore === true, 'Guild A nightcore survived restart');
    assert(stateAAfterRestart.loopMode === 'track', 'Guild A loop_mode survived restart');
    assert(stateAAfterRestart.stayInChannel === true, 'Guild A stay_in_channel survived restart');

    // -----------------------------------------------------------------
    // 6. PLAYBACK & QUEUE LIFECYCLE WITH RICH METADATA
    // -----------------------------------------------------------------
    console.log('\n--- 6. Playback & Queue Lifecycle with Rich Metadata ---');

    const queueManager = new QueueManager(logger);
    const mockVoiceAdapter = new Phase5MockVoiceAdapter();
    const playbackManager = new PlaybackManager(
      logger,
      queueManager,
      300,
      settingsManager,
    );
    playbackManager.registerAdapter(mockVoiceAdapter);

    const guildId = 'guild_playback_test';
    await playbackManager.join(guildId, 'mock-channel-1');

    // Add track with rich metadata
    queueManager.addTrack(guildId, {
      id: 't-1',
      name: 'Synthwave After Dark',
      path: testTrack2,
      duration: 256,
      addedBy: 'Phase5User',
      artist: 'Mr.Synth',
      album: 'Neon Nights',
      artwork: '/api/artwork/cache/test_art.jpg',
      source: 'local',
    });

    assert(queueManager.getQueueLength(guildId) === 1, 'Track added to queue');

    // Play next
    const played = await playbackManager.advanceQueue(guildId);
    assert(played === true, 'PlaybackManager successfully started playing queue track');
    assert(mockVoiceAdapter.getPlaybackStatus(guildId) === 'PLAYING', 'Voice adapter status is PLAYING');

    const queueEvent = playbackManager.getQueueEvent(guildId);
    assert(queueEvent.currentTrack !== null, 'Current track is present in queue event');
    assert(queueEvent.currentTrack?.name === 'Synthwave After Dark', 'Current track title preserved');
    assert(queueEvent.currentTrack?.artist === 'Mr.Synth', 'Current track artist metadata preserved');
    assert(queueEvent.currentTrack?.album === 'Neon Nights', 'Current track album metadata preserved');
    assert(queueEvent.currentTrack?.source === 'local', 'Current track source preserved');

    // Change volume and persist
    playbackManager.setVolume(guildId, 60);
    assert(playbackManager.getGuildState(guildId).volume === 60, 'Runtime volume updated to 60');

    // Verify DB update happened asynchronously
    await new Promise((r) => setTimeout(r, 100));
    const reloadedSettings = await settingsManager.getSettings(guildId);
    assert(reloadedSettings.volume === 60, 'Persistent database updated with new volume');

    // -----------------------------------------------------------------
    // 7. FAILURE RESILIENCE
    // -----------------------------------------------------------------
    console.log('\n--- 7. Remote Stream & Pipeline Failure Resilience ---');

    const failGuildId = 'guild_failure_test';
    await playbackManager.join(failGuildId, 'mock-channel-fail');

    // Corrupt / non-existent track handling
    let errorHandled = false;
    try {
      await playbackManager.play(
        failGuildId,
        {
          sourceType: 'local',
          identifier: 'non_existent_audio_file.mp3',
          validate: async () => {
            throw new Error('Local audio file not found: non_existent_audio_file.mp3');
          },
          getStream: async () => new (await import('node:stream')).Readable({ read() {} }),
          getMetadata: async () => ({ title: 'Non-existent', duration: null }),
        },
        {
          name: 'Non-existent',
          path: 'non_existent_audio_file.mp3',
        },
      );
    } catch (err: any) {
      errorHandled = true;
    }
    assert(errorHandled, 'Playback of non-existent source gracefully throws without crashing server');
    assert(playbackManager.getPlaybackStatus(failGuildId) !== 'ERROR', 'Playback manager state remains operational');

    console.log('\n============================================================');
    console.log(`🎉 ALL ${passedTests}/${totalTests} PHASE 5 TESTS PASSED SUCCESSFULLY!`);
    console.log('============================================================\n');

  } finally {
    // Cleanup temporary test files
    try {
      if (fs.existsSync(testMusicDir)) {
        fs.rmSync(testMusicDir, { recursive: true, force: true });
      }
      if (fs.existsSync(testCacheDir)) {
        fs.rmSync(testCacheDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup error
    }
    try {
      await disconnectDatabase();
    } catch {
      // Ignore disconnect error
    }
  }
}

runPhase5TestSuite()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Test Suite Failed with Exception:', err);
    process.exit(1);
  });
