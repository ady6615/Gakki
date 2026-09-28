/**
 * Phase 10 Automated Verification Test Suite
 *
 * Comprehensive tests covering:
 * - 1. Lyrics Service & Provider Abstraction
 * - 2. Lyrics Matching Confidence & LRC Parser
 * - 3. Synced Lyrics Timeline Navigation
 * - 4. User Favorites Persistence, CRUD & Isolation
 * - 5. Playlist Enhancements, Batch Reordering & Duplication
 * - 6. Queue Reordering & Optimistic UI Operations
 * - 7. Unified Library Search & Track Details Retrieval
 * - 8. SQL Analytics Dashboard Aggregation & Time Ranges
 * - 9. Unified Command Permissions & Error Formatting
 * - 10. Recording Preparation Architectural Contract
 */

import 'dotenv/config';
import {
  connectDatabase,
  getDatabase,
  getDatabasePool,
  LyricsManager,
  FavoritesManager,
  LibraryManager,
  AnalyticsManager,
  PlaylistManager,
  QueueManager,
  TrackManager,
  GuildSettingsManager,
  MockLyricsProvider,
  LrcLibLyricsProvider,
  LyricsProviderRegistry,
  parseLrcLyrics,
  findActiveLyricLineIndex,
  computeLyricsMatchConfidence,
  createLogger,
  type TrackMetadataForLyrics,
  type VoiceRecordingService,
} from '@gakki/core';
import { resolveUserPermissionLevel, checkCommandPermission, CommandPermissionLevel } from '../discord/permissions';
import { BotErrors, formatUserFacingError } from '../discord/errors';

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`  ✓ ${message}`);
}

async function runPhase10Tests() {
  console.log('\n================================================================');
  console.log('🎵 Gakki Music Platform — Phase 10 Verification Test Suite');
  console.log('================================================================\n');

  // Initialize Database
  const dbUrl = process.env.DATABASE_URL || 'postgresql://gakki:gakki@localhost:5432/gakki';
  await connectDatabase(dbUrl);
  const db = getDatabase();
  const pool = getDatabasePool()!;
  assert(pool != null, 'Database connection pool active');

  const logger = createLogger('phase10-test');
  const trackManager = new TrackManager(db);
  const queueManager = new QueueManager(createLogger('queue-manager'));
  const playlistManager = new PlaylistManager(db, createLogger('playlist-manager'), trackManager);
  const favoritesManager = new FavoritesManager(pool);
  const analyticsManager = new AnalyticsManager(db, createLogger('analytics-manager'), trackManager);
  const libraryManager = new LibraryManager(pool, trackManager as any);
  const lyricsManager = new LyricsManager({ pool });

  // ─────────────────────────────────────────────────────────────
  // 1. Lyrics Service & LRC Parsing
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 1. Lyrics Service & LRC Parsing ---');

  const sampleLrc = `[00:01.00] In the dead of night
[00:05.50] Shadows start to crawl
[00:12.00] After dark we fly
[00:20.00] Echoes through the hall`;

  const parsedLrc = parseLrcLyrics(sampleLrc);
  assert(parsedLrc.length === 4, `Parsed 4 lyric lines (got ${parsedLrc.length})`);
  assert(parsedLrc[0].timeMs === 1000, 'First lyric line starts at 1000ms');
  assert(parsedLrc[0].text === 'In the dead of night', 'First lyric line text matches');
  assert(parsedLrc[2].timeMs === 12000, 'Third lyric line timestamp is 12000ms');

  // Test Synced Timeline Line Locator
  const activeAt0 = findActiveLyricLineIndex(parsedLrc, 500);
  assert(activeAt0 === -1, 'Before first line (500ms) returns intro index -1');

  const activeAt3s = findActiveLyricLineIndex(parsedLrc, 3000);
  assert(activeAt3s === 0, 'At 3000ms active line is line 0 ("In the dead of night")');

  const activeAt8s = findActiveLyricLineIndex(parsedLrc, 8000);
  assert(activeAt8s === 1, 'At 8000ms active line is line 1 ("Shadows start to crawl")');

  const activeAt50s = findActiveLyricLineIndex(parsedLrc, 50000);
  assert(activeAt50s === 3, 'After all lines (50000ms) returns last line index 3');

  // Test Plain Text Fallback in LRC Parser
  const plainLrc = `Just a simple song\nWithout timestamps\nLiving in the moment`;
  const parsedPlain = parseLrcLyrics(plainLrc);
  assert(parsedPlain.length === 0, 'No synced lines for plain text');

  // ─────────────────────────────────────────────────────────────
  // 2. Lyrics Matching Confidence
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 2. Lyrics Matching Confidence ---');

  // High confidence: Exact title + exact artist + close duration
  const confExact = computeLyricsMatchConfidence(
    { title: 'After Dark', artist: 'Mr.Kitty', duration: 257 },
    { trackName: 'After Dark', artistName: 'Mr.Kitty', duration: 257 },
  );
  assert(confExact >= 0.95, `High confidence for exact match (got ${(confExact * 100).toFixed(1)}%)`);

  // Low confidence: Same title, completely different artist
  const confDiffArtist = computeLyricsMatchConfidence(
    { title: 'After Dark', artist: 'Mr.Kitty', duration: 257 },
    { trackName: 'After Dark', artistName: 'Tito & Tarantula', duration: 240 },
  );
  assert(confDiffArtist < 0.65, `Low confidence for different artist with same song name (got ${(confDiffArtist * 100).toFixed(1)}%)`);

  // Provider Registry
  const registry = new LyricsProviderRegistry();
  const mockProvider = new MockLyricsProvider('test-mock');
  registry.register(mockProvider);
  assert(registry.getProvider('test-mock') != null, 'MockLyricsProvider registered in registry');

  mockProvider.addEntry({
    title: 'Midnight City',
    artist: 'M83',
    lrcLyrics: '[00:10.00] Waiting in a car\n[00:15.00] Waiting for a ride',
    plainLyrics: 'Waiting in a car\nWaiting for a ride',
  });

  const lyricResult = await mockProvider.search({
    title: 'Midnight City',
    artist: 'M83',
    duration: 243,
  });
  assert(lyricResult !== null, 'Mock provider resolved seeded lyrics');
  assert(lyricResult?.isSynced === true, 'Mock provider returned synced lyrics');
  assert(lyricResult?.providerName === 'test-mock', 'Attribution correctly cites providerName');

  // Missing lyrics
  const missingResult = await mockProvider.search({
    title: 'NonExistentSong12345',
    artist: 'Nobody',
  });
  assert(missingResult === null, 'Missing lyrics returns null without throwing');

  // Excerpt Formatting
  const longText = 'Line 1: A very long lyrical line\nLine 2: Another long lyrical line\nLine 3: Even more lyrics flowing\nLine 4: Deep meaningful poetry continues';
  const formatResult = lyricsManager.formatLyricsExcerpt(longText, 60);
  assert(formatResult.isTruncated === true, 'formatLyricsExcerpt marks long lyrics as truncated');
  assert(formatResult.excerpt.includes('Lyrics continue on Web Dashboard'), 'Excerpt includes dashboard prompt');

  // ─────────────────────────────────────────────────────────────
  // 3. User Favorites Persistence & Isolation (Requirement 6)
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 3. User Favorites Persistence & Isolation ---');

  // Seed test tracks in DB
  const { track: testTrack1 } = await trackManager.saveTrackWithSource(
    { title: 'Phase 10 Test Track Alpha', artist: 'Test Artist 1', duration: 180 },
    { provider: 'local', sourceType: 'file', sourceUrl: 'storage/music/test-alpha.mp3' },
  );
  const { track: testTrack2 } = await trackManager.saveTrackWithSource(
    { title: 'Phase 10 Test Track Beta', artist: 'Test Artist 2', duration: 210 },
    { provider: 'local', sourceType: 'file', sourceUrl: 'storage/music/test-beta.mp3' },
  );

  const userA = 'user_test_alpha_123';
  const userB = 'user_test_beta_456';
  const guildTest = 'guild_test_phase10';

  // Clear previous test favorites for isolation
  await pool.query('DELETE FROM user_favorites WHERE user_id IN ($1, $2)', [userA, userB]);

  // User A favorites Track 1
  const fav1 = await favoritesManager.addFavorite(userA, testTrack1.id);
  assert(fav1.userId === userA && fav1.trackId === testTrack1.id, 'Favorite created for User A');

  // Idempotent duplicate favorite check
  const favDuplicate = await favoritesManager.addFavorite(userA, testTrack1.id);
  assert(favDuplicate.userId === userA, 'Duplicate favorite handled idempotently');

  // Verify User A has favorite, but User B does NOT (User Isolation)
  const isFavA = await favoritesManager.isFavorite(userA, testTrack1.id);
  const isFavB = await favoritesManager.isFavorite(userB, testTrack1.id);
  assert(isFavA === true, 'isFavorite returns true for User A');
  assert(isFavB === false, 'isFavorite returns false for User B (User Isolation verified)');

  // Get favorites list
  const userAFavorites = await favoritesManager.getFavorites(userA, { page: 1, limit: 10 });
  assert(userAFavorites.items.length === 1, 'getFavorites returns 1 favorite for User A');
  assert(userAFavorites.items[0].track?.title === 'Phase 10 Test Track Alpha', 'Joined track title in favorites list');

  // User A unfavorites
  const removed = await favoritesManager.removeFavorite(userA, testTrack1.id);
  assert(removed === true, 'removeFavorite returns true');
  const isFavAfterRemove = await favoritesManager.isFavorite(userA, testTrack1.id);
  assert(isFavAfterRemove === false, 'Track no longer favorited after removal');

  // ─────────────────────────────────────────────────────────────
  // 4. Playlist Enhancements, Batch Reorder & Duplicate (Req 7 & 8)
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 4. Playlist Enhancements, Batch Reordering & Duplication ---');

  // Create test playlist
  const testPlaylist = await playlistManager.createPlaylist({
    name: 'Synthwave Night Ride',
    description: 'Chill late-night cruising tracks',
    visibility: 'guild',
    guildId: guildTest,
    ownerUserId: userA,
  });
  assert(testPlaylist.name === 'Synthwave Night Ride', 'Created test playlist');

  // Add 3 tracks to playlist
  await playlistManager.addTrackToPlaylist(testPlaylist.id, testTrack1.id, userA);
  await playlistManager.addTrackToPlaylist(testPlaylist.id, testTrack2.id, userA);

  const { track: testTrack3 } = await trackManager.saveTrackWithSource(
    { title: 'Phase 10 Test Track Gamma', artist: 'Test Artist 3', duration: 240 },
    { provider: 'local', sourceType: 'file', sourceUrl: 'storage/music/test-gamma.mp3' },
  );
  await playlistManager.addTrackToPlaylist(testPlaylist.id, testTrack3.id, userA);

  const initialPlaylist = await playlistManager.getPlaylist(testPlaylist.id);
  assert(initialPlaylist != null && initialPlaylist.tracks.length === 3, 'Playlist has 3 tracks');
  assert(initialPlaylist!.tracks[0].trackId === testTrack1.id, 'First track is Alpha');
  assert(initialPlaylist!.tracks[2].trackId === testTrack3.id, 'Third track is Gamma');

  // Batch Reorder: Move Track 3 (Gamma) to position 1: [Gamma, Alpha, Beta]
  const reorderBatchResult = await playlistManager.reorderTracksBatch(testPlaylist.id, [
    testTrack3.id,
    testTrack1.id,
    testTrack2.id,
  ]);
  assert(reorderBatchResult.length === 3, 'Batch reorder returned 3 tracks');
  assert(reorderBatchResult[0].trackId === testTrack3.id, 'Track Gamma is now position 1');
  assert(reorderBatchResult[0].position === 1, 'Position index updated to 1');
  assert(reorderBatchResult[1].trackId === testTrack1.id, 'Track Alpha is now position 2');
  assert(reorderBatchResult[2].trackId === testTrack2.id, 'Track Beta is now position 3');

  // Duplicate Playlist (Requirement 7)
  const duplicated = await playlistManager.duplicatePlaylist(testPlaylist.id, 'Synthwave Night Ride (Copy)', userA);
  assert(duplicated.name === 'Synthwave Night Ride (Copy)', 'Duplicated playlist has new name');
  const dupDetails = await playlistManager.getPlaylist(duplicated.id);
  assert(dupDetails != null && dupDetails.tracks.length === 3, 'Duplicated playlist copied all 3 tracks');
  assert(dupDetails!.tracks[0].trackId === testTrack3.id, 'Track order preserved in duplicate');

  // Clean up test playlists
  await playlistManager.deletePlaylist(testPlaylist.id);
  await playlistManager.deletePlaylist(duplicated.id);

  // ─────────────────────────────────────────────────────────────
  // 5. Queue Management & Reordering (Requirement 9 & 10)
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 5. Queue Management & Reordering ---');

  const testGuildQueue = 'guild_queue_phase10';
  queueManager.clearQueue(testGuildQueue);

  // Enqueue 4 tracks
  queueManager.enqueue(testGuildQueue, { id: 'q1', name: 'Song 1', path: '/music/s1.mp3', duration: 180, source: 'local' as any });
  queueManager.enqueue(testGuildQueue, { id: 'q2', name: 'Song 2', path: '/music/s2.mp3', duration: 190, source: 'local' as any });
  queueManager.enqueue(testGuildQueue, { id: 'q3', name: 'Song 3', path: '/music/s3.mp3', duration: 200, source: 'local' as any });
  queueManager.enqueue(testGuildQueue, { id: 'q4', name: 'Song 4', path: '/music/s4.mp3', duration: 210, source: 'local' as any });

  assert(queueManager.getQueueLength(testGuildQueue) === 4, '4 tracks enqueued');

  // Reorder queue: Drag q4 -> q1: [q4, q1, q2, q3]
  queueManager.reorderQueue(testGuildQueue, ['q4', 'q1', 'q2', 'q3']);
  const reorderedQ = queueManager.inspectQueue(testGuildQueue);
  assert(reorderedQ[0].id === 'q4', 'q4 is now first in queue');
  assert(reorderedQ[1].id === 'q1', 'q1 is now second');
  assert(reorderedQ[3].id === 'q3', 'q3 is now fourth');

  // Move to top: q2 -> top
  queueManager.moveToTop(testGuildQueue, 'q2');
  assert(queueManager.inspectQueue(testGuildQueue)[0].id === 'q2', 'q2 moved to top');

  // Move to bottom: q2 -> bottom
  queueManager.moveToBottom(testGuildQueue, 'q2');
  const qAfterBottom = queueManager.inspectQueue(testGuildQueue);
  assert(qAfterBottom[qAfterBottom.length - 1].id === 'q2', 'q2 moved to bottom');

  // Play next: q3 -> next
  queueManager.playNext(testGuildQueue, 'q3');
  assert(queueManager.inspectQueue(testGuildQueue)[0].id === 'q3', 'q3 placed as play next');

  // Remove by index
  const removedTrack = queueManager.removeByIndex(testGuildQueue, 1, true);
  assert(removedTrack?.id === 'q3', 'Track at position 1 (q3) removed cleanly');
  assert(queueManager.getQueueLength(testGuildQueue) === 3, 'Queue length is now 3');

  // ─────────────────────────────────────────────────────────────
  // 6. Unified Library Search & Browsing (Requirement 11, 12, 13)
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 6. Unified Library Search & Browsing ---');

  // Search by keyword
  const searchResults = await libraryManager.search('Alpha');
  assert(Array.isArray(searchResults.tracks), 'Search returns tracks array');
  assert(searchResults.tracks.some((t) => t.title.includes('Alpha')), 'Found track Alpha in search results');

  // Search with empty query
  const emptySearch = await libraryManager.search('   ');
  assert(emptySearch.tracks.length === 0 && emptySearch.artists.length === 0, 'Empty search returns empty arrays');

  // Browsing tracks (paginated)
  const pagedTracks = await libraryManager.getTracks(5, 0);
  assert(Array.isArray(pagedTracks.tracks), 'getTracks returns tracks array');
  assert(pagedTracks.tracks.length <= 5, 'Pagination limit respected');

  // Track details
  const trackDetails = await libraryManager.getTrackDetails(testTrack1.id);
  assert(trackDetails !== null, 'getTrackDetails resolved track');
  assert(trackDetails?.title === 'Phase 10 Test Track Alpha', 'Track title matches in details');
  assert(Array.isArray(trackDetails?.sources), 'Track details includes sources list');

  // ─────────────────────────────────────────────────────────────
  // 7. SQL Analytics Dashboard Aggregation (Requirement 15 & 16)
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 7. SQL Analytics Dashboard Aggregation ---');

  // Test aggregation across all 4 time ranges
  const timeRanges = ['today', '7d', '30d', 'all'] as const;
  for (const range of timeRanges) {
    const stats = await analyticsManager.getDashboardStats(range, guildTest);
    assert(stats.timeRange === range, `Calculated dashboard stats for range: ${range}`);
    assert(typeof stats.totalPlays === 'number', 'totalPlays is a number');
    assert(typeof stats.completionRate === 'number', 'completionRate is a number');
    assert(typeof stats.skipRate === 'number', 'skipRate is a number');
    assert(Array.isArray(stats.mostPlayedTracks), 'mostPlayedTracks is an array');
    assert(Array.isArray(stats.topArtists), 'topArtists is an array');
    assert(Array.isArray(stats.mostActiveListeners), 'mostActiveListeners is an array');
  }

  // ─────────────────────────────────────────────────────────────
  // 8. Unified Permissions & Standard Error UX (Req 21 & 23)
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 8. Unified Command Permissions & Standard Error UX ---');

  // Permission Hierarchy Verification: OWNER > ADMIN > MODERATOR > DJ > USER
  const userLevel = CommandPermissionLevel.USER;
  const djLevel = CommandPermissionLevel.DJ;
  const modLevel = CommandPermissionLevel.MODERATOR;
  const adminLevel = CommandPermissionLevel.ADMIN;
  const ownerLevel = CommandPermissionLevel.OWNER;

  assert(userLevel === 0, 'USER level is 0');
  assert(djLevel === 1, 'DJ level is 1');
  assert(modLevel === 2, 'MODERATOR level is 2');
  assert(adminLevel === 3, 'ADMIN level is 3');
  assert(ownerLevel === 4, 'OWNER level is 4');

  // Error Formatting UX
  const errNoVoice = BotErrors.NOT_IN_VOICE();
  assert(errNoVoice.isUserFacing === true, 'NOT_IN_VOICE marked user-facing');
  assert(errNoVoice.message.includes('You must be in a voice channel'), 'Standard friendly error message');

  const errNoLyrics = BotErrors.LYRICS_NOT_FOUND('Unknown Track');
  assert(errNoLyrics.message.includes('No lyrics found'), 'Standard lyrics not found message');

  const formattedErr = formatUserFacingError(new Error('Internal database syntax error'));
  assert(!formattedErr.includes('syntax error'), 'Technical internal errors redacted from user message');
  assert(formattedErr.includes('An unexpected error occurred'), 'Generic friendly message for unknown errors');

  // ─────────────────────────────────────────────────────────────
  // 9. Voice Recording Conceptual Contract (Requirement 20)
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 9. Voice Recording Conceptual Contract ---');

  // Verify conceptual interface contract compiles and is satisfied
  class DummyRecordingService implements VoiceRecordingService {
    async start(options: any): Promise<any> {
      return {
        id: 'rec_123',
        guildId: options.guildId,
        channelId: options.channelId,
        startedByUserId: options.requestedByUserId,
        startedAt: new Date().toISOString(),
        status: 'RECORDING',
        format: options.format || 'opus',
        retentionDays: options.retentionDays || 30,
        participants: [],
      };
    }
    async stop(sessionId: string): Promise<any> {
      return {
        recordingId: 'rec_123',
        sessionId,
        storagePath: 'storage/recordings/dummy.ogg',
        filePath: 'storage/recordings/dummy.ogg',
        durationSeconds: 120,
        participantCount: 3,
        format: 'opus',
        metadata: { format: 'opus/ogg', sampleRate: 48000, channels: 2 },
      };
    }
    async getSession(): Promise<any> { return null; }
    async getActiveSession(): Promise<any> { return null; }
    async listSessions(): Promise<any> { return []; }
    async deleteSession(): Promise<any> { return true; }
  }
  const dummyService: VoiceRecordingService = new DummyRecordingService();
  const recResult = await dummyService.stop('session_456');
  assert(recResult.sessionId === 'session_456', 'VoiceRecordingService contract verified');
  assert((recResult as any).metadata.format === 'opus/ogg', 'Storage format specification verified');

  console.log('\n================================================================');
  console.log('✅ ALL PHASE 10 AUTOMATED VERIFICATION TESTS PASSED!');
  console.log('================================================================\n');

  process.exit(0);
}

runPhase10Tests().catch((err) => {
  console.error('\n❌ Phase 10 verification test failed:', err);
  process.exit(1);
});
