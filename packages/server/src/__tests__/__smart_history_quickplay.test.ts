/**
 * Smart Music Persistence, Most Played Playlists & QuickPlay Menu Verification Suite
 */

import {
  TrackManager,
  PlaylistManager,
  AnalyticsManager,
  inferGenre,
  createLogger,
  PlaybackManager,
  QueueManager,
} from '@gakki/core';
import { buildQuickPlayMenu, handleQuickPlayInteraction } from '../discord/quickplay-menu';

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`  ✓ ${message}`);
}

async function runTests() {
  console.log('\n================================================================');
  console.log('🎵 Running Smart History, Most Played & QuickPlay Test Suite');
  console.log('================================================================\n');

  const logger = createLogger('test-history-quickplay');
  const trackManager = new TrackManager(null);
  const playlistManager = new PlaylistManager(null, logger, trackManager);
  const analyticsManager = new AnalyticsManager(null, logger, trackManager);
  const queueManager = new QueueManager(logger);
  const playbackManager = new PlaybackManager(logger, queueManager, 300, undefined, analyticsManager, trackManager);

  // ──────────────────────────────────────────────────────────────────
  console.log('\n--- 1. Intelligent Genre Inference & Persistent Storage ---');
  // ──────────────────────────────────────────────────────────────────
  assert(
    inferGenre({ title: 'Lo-Fi Chill Beats for Studying', artist: 'Lofi Girl' }) === 'Lo-Fi / Chill',
    'Infers Lo-Fi / Chill genre correctly',
  );
  assert(
    inferGenre({ title: 'Master of Puppets', artist: 'Metallica', album: 'Heavy Metal' }) === 'Rock / Metal',
    'Infers Rock / Metal genre correctly',
  );
  assert(
    inferGenre({ title: 'Sicko Mode', artist: 'Travis Scott', album: 'Rap Album' }) === 'Hip-Hop / Rap',
    'Infers Hip-Hop / Rap genre correctly',
  );
  assert(
    inferGenre({ title: 'Levels (Original Mix)', artist: 'Avicii', album: 'EDM Festival' }) === 'Electronic / EDM',
    'Infers Electronic / EDM genre correctly',
  );
  assert(
    inferGenre({ title: 'Gurenge', artist: 'LiSA', album: 'Demon Slayer OST' }) === 'Anime / J-Pop / K-Pop',
    'Infers Anime / J-Pop / K-Pop genre correctly',
  );
  assert(
    inferGenre({ title: 'Moonlight Sonata', artist: 'Beethoven', album: 'Piano Classics' }) === 'Classical / Instrumental',
    'Infers Classical / Instrumental genre correctly',
  );
  assert(
    inferGenre({ title: 'Despacito', artist: 'Luis Fonsi', album: 'Reggaeton' }) === 'Latin / Reggaeton',
    'Infers Latin / Reggaeton genre correctly',
  );

  // Persist song links with metadata and genres
  const savedTrack = await trackManager.saveTrackWithSource(
    {
      title: 'Animals (Official Audio)',
      artist: 'Martin Garrix',
      duration: 184,
      thumbnailUrl: 'https://i.ytimg.com/vi/gCYcTmV9wd4/hqdefault.jpg',
    },
    {
      provider: 'youtube',
      sourceType: 'stream',
      sourceUrl: 'https://www.youtube.com/watch?v=gCYcTmV9wd4',
      externalId: 'gCYcTmV9wd4',
    },
  );

  assert(!!savedTrack.track.id, 'Persisted track has a unique ID');
  assert(savedTrack.track.title === 'Animals (Official Audio)', 'Track title persisted accurately');
  assert(savedTrack.track.genre === 'Electronic / EDM', 'Track genre inferred and persisted');
  assert(savedTrack.source.sourceUrl === 'https://www.youtube.com/watch?v=gCYcTmV9wd4', 'Track source URL persisted');

  // Query by genre
  const edmTracks = await trackManager.getTracksByGenre('Electronic');
  assert(edmTracks.length >= 1, 'getTracksByGenre returns persisted electronic songs');
  assert(edmTracks[0].title === 'Animals (Official Audio)', 'Matched electronic track title');

  // Query distinct genres
  const distinct = await trackManager.getDistinctGenres();
  assert(distinct.some((g) => g.genre.includes('Electronic')), 'getDistinctGenres lists Electronic genre');

  // Persist external playlist (Spotify import)
  const savedPl = await playlistManager.saveExternalPlaylist({
    name: 'Top Hits 2026',
    description: 'Imported from Spotify',
    guildId: 'guild_123',
    ownerUserId: 'user_456',
    tracks: [
      {
        title: 'Midnight City',
        artist: 'M83',
        duration: 243,
        sourceUrl: 'https://open.spotify.com/track/12345',
        provider: 'spotify',
      },
      {
        title: 'Blinding Lights',
        artist: 'The Weeknd',
        duration: 200,
        sourceUrl: 'https://open.spotify.com/track/67890',
        provider: 'spotify',
      },
    ],
  });

  assert(savedPl.name === 'Top Hits 2026', 'Imported playlist name saved');
  assert(savedPl.trackCount === 2, 'Imported playlist trackCount is 2');

  const plDetails = await playlistManager.getPlaylist(savedPl.id);
  assert(!!plDetails && plDetails.tracks.length === 2, 'Retrieved imported playlist tracks from database');
  assert(plDetails?.tracks[0]?.track?.title === 'Midnight City', 'First track in imported playlist is Midnight City');
  assert(plDetails?.tracks[0]?.source?.sourceUrl === 'https://open.spotify.com/track/12345', 'First track has Spotify URL');

  // ──────────────────────────────────────────────────────────────────
  console.log('\n--- 2. Dynamic "Most Played" Playlist Generation ---');
  // ──────────────────────────────────────────────────────────────────
  const guildId = 'guild_test_analytics';

  const t1 = await trackManager.saveTrackWithSource(
    { title: 'Song Alpha', artist: 'Artist A', duration: 180 },
    { provider: 'youtube', sourceType: 'stream', sourceUrl: 'https://yt.com/1' },
  );
  const t2 = await trackManager.saveTrackWithSource(
    { title: 'Song Beta', artist: 'Artist B', duration: 210 },
    { provider: 'youtube', sourceType: 'stream', sourceUrl: 'https://yt.com/2' },
  );

  // Play t1 3 times, t2 1 time
  await analyticsManager.recordPlaybackStart({ guildId, trackId: t1.track.id, trackTitle: 'Song Alpha', artist: 'Artist A' });
  await analyticsManager.recordPlaybackStart({ guildId, trackId: t1.track.id, trackTitle: 'Song Alpha', artist: 'Artist A' });
  await analyticsManager.recordPlaybackStart({ guildId, trackId: t1.track.id, trackTitle: 'Song Alpha', artist: 'Artist A' });
  await analyticsManager.recordPlaybackStart({ guildId, trackId: t2.track.id, trackTitle: 'Song Beta', artist: 'Artist B' });

  // Sync most played playlist
  const mostPlayed = await playlistManager.syncMostPlayedPlaylist(guildId, analyticsManager, 10);
  assert(mostPlayed.name === '🔥 Most Played', 'Created "🔥 Most Played" playlist');

  const mostPlayedDetails = await playlistManager.getPlaylist(mostPlayed.id);
  assert(!!mostPlayedDetails && mostPlayedDetails.tracks.length === 2, 'Most Played playlist contains 2 tracks');
  assert(mostPlayedDetails?.tracks[0]?.track?.title === 'Song Alpha', 'Most played track (Song Alpha) is ordered first');
  assert(mostPlayedDetails?.tracks[1]?.track?.title === 'Song Beta', 'Second most played track (Song Beta) is ordered second');

  // ──────────────────────────────────────────────────────────────────
  console.log('\n--- 3. QuickPlay / Welcome Menu Verification ---');
  // ──────────────────────────────────────────────────────────────────
  const menuGuildId = 'guild_menu_test';

  const menuTrack = await trackManager.saveTrackWithSource(
    { title: 'Cyberpunk Synthwave', artist: 'Kavinsky', duration: 250 },
    { provider: 'spotify', sourceType: 'stream', sourceUrl: 'https://spotify.com/track/synth' },
  );

  await playlistManager.saveExternalPlaylist({
    name: 'Synthwave Night',
    guildId: menuGuildId,
    tracks: [{ title: 'Cyberpunk Synthwave', artist: 'Kavinsky', sourceUrl: 'https://spotify.com/track/synth' }],
  });

  await analyticsManager.recordPlaybackStart({
    guildId: menuGuildId,
    trackId: menuTrack.track.id,
    trackTitle: 'Cyberpunk Synthwave',
    artist: 'Kavinsky',
  });

  const menu = await buildQuickPlayMenu(menuGuildId, {
    analyticsManager,
    playlistManager,
    trackManager,
  });

  assert(menu.embeds.length === 1, 'QuickPlay menu generates 1 rich embed');
  assert(menu.embeds[0].data.title?.includes('QuickPlay Music Menu') || false, 'QuickPlay embed has title');
  assert(
    menu.embeds[0].data.fields?.some((f) => f.name.includes('Most Played')) || false,
    'QuickPlay embed includes Most Played field',
  );

  // Buttons in Row 1
  assert(menu.components.length >= 2, 'QuickPlay menu includes action rows');
  const buttonRow: any = menu.components[0];
  const customIds = buttonRow.components.map((c: any) => c.data.custom_id);
  assert(customIds.includes('gakki:qp:most_played'), 'Includes "Most Played" button');
  assert(customIds.includes('gakki:qp:recent'), 'Includes "Recent Songs" button');
  assert(customIds.includes('gakki:qp:genre_mix'), 'Includes "Genre Mix" button');
  assert(customIds.includes('gakki:qp:smart_mix'), 'Includes "Smart Vibe" button');
  assert(customIds.includes('gakki:qp:panel'), 'Includes "Player Panel" button');

  // Select Menu in Row 2
  const playlistRow: any = menu.components[1];
  assert(
    playlistRow.components[0].data.custom_id === 'gakki:qp:select_playlist',
    'Includes "select_playlist" dropdown',
  );

  // Test QuickPlay Button Interaction
  let repliedTitle = '';
  const mockInteraction: any = {
    guildId: menuGuildId,
    customId: 'gakki:qp:most_played',
    isButton: () => true,
    isStringSelectMenu: () => false,
    deferReply: async () => {},
    editReply: async (msg: any) => {
      repliedTitle = msg.embeds?.[0]?.data?.title || msg.content || '';
    },
    member: { displayName: 'Tester', voice: { channel: { id: 'vc_123' } } },
    user: { id: 'u_123', username: 'Tester' },
    client: { guilds: { fetch: async () => null } },
  };

  playbackManager.join = async () => {};
  (playbackManager as any).play = async () => ({
    status: 'started',
    position: 1,
    track: { name: 'Most Played Song', path: 'path', duration: 200 },
  });

  await handleQuickPlayInteraction(mockInteraction, {
    playbackManager,
    analyticsManager,
    playlistManager,
    trackManager,
  });

  assert(repliedTitle.includes('Most Played'), 'QuickPlay button interaction starts Most Played playlist playback');

  // Verify that an empty guild without any playlists STILL retains the "select_playlist" dropdown
  const emptyMenu = await buildQuickPlayMenu('brand_new_empty_guild', {
    analyticsManager,
    playlistManager,
    trackManager,
  });
  assert(
    emptyMenu.components.some((row: any) =>
      row.components.some((c: any) => c.data.custom_id === 'gakki:qp:select_playlist'),
    ),
    'Empty guild menu STILL includes the "Select a Previous Playlist to Play" select menu',
  );
  const selectComp: any = emptyMenu.components[1]?.components[0];
  assert(
    selectComp.data.placeholder?.includes('Select a Previous Playlist to Play'),
    'Empty guild select menu retains the placeholder "Select a Previous Playlist to Play..."',
  );

  // Test selecting dynamic mix from dropdown
  let dropdownRepliedTitle = '';
  const mockDropdownInteraction: any = {
    guildId: menuGuildId,
    customId: 'gakki:qp:select_playlist',
    values: ['auto:most_played'],
    isButton: () => false,
    isStringSelectMenu: () => true,
    deferReply: async () => {},
    editReply: async (msg: any) => {
      dropdownRepliedTitle = msg.embeds?.[0]?.data?.title || msg.content || '';
    },
    member: { displayName: 'Tester', voice: { channel: { id: 'vc_123' } } },
    user: { id: 'u_123', username: 'Tester' },
    client: { guilds: { fetch: async () => null } },
  };

  await handleQuickPlayInteraction(mockDropdownInteraction, {
    playbackManager,
    analyticsManager,
    playlistManager,
    trackManager,
  });
  assert(dropdownRepliedTitle.includes('Most Played'), 'Dropdown selection "auto:most_played" triggers Most Played playback');

  // ──────────────────────────────────────────────────────────────────
  console.log('\n--- 4. "Play the Songs I Played Yesterday" & 2-3 Day Auto-Cleanup Verification ---');
  // ──────────────────────────────────────────────────────────────────
  const yGuildId = 'guild_yesterday_suite';
  const yUserId = 'user_yesterday_123';
  const todayRef = new Date('2026-10-12T12:00:00Z');
  const yesterdayDate1 = new Date('2026-10-11T14:30:00Z');
  const yesterdayDate2 = new Date('2026-10-11T19:45:00Z');
  const todayDate = new Date('2026-10-12T08:15:00Z');
  const oldDate = new Date('2026-10-08T10:00:00Z'); // 4 days ago

  const yTrack1 = await trackManager.saveTrackWithSource(
    { title: 'Neon Highway', artist: 'Kavinsky', duration: 210 },
    { provider: 'youtube', sourceType: 'stream', sourceUrl: 'https://yt.com/neon' },
  );
  const yTrack2 = await trackManager.saveTrackWithSource(
    { title: 'Midnight Stroll', artist: 'Lofi Beats', duration: 160 },
    { provider: 'youtube', sourceType: 'stream', sourceUrl: 'https://yt.com/midnight' },
  );
  const tTrack = await trackManager.saveTrackWithSource(
    { title: 'Morning Coffee', artist: 'Sunny Day', duration: 180 },
    { provider: 'youtube', sourceType: 'stream', sourceUrl: 'https://yt.com/morning' },
  );
  const oldTrack = await trackManager.saveTrackWithSource(
    { title: 'Ancient Echoes', artist: 'Oldies', duration: 240 },
    { provider: 'youtube', sourceType: 'stream', sourceUrl: 'https://yt.com/ancient' },
  );

  // Record playback starts across dates
  await analyticsManager.recordPlaybackStart({
    guildId: yGuildId,
    trackId: yTrack1.track.id,
    userId: yUserId,
    trackTitle: 'Neon Highway',
    artist: 'Kavinsky',
    startedAt: yesterdayDate1,
  });
  await analyticsManager.recordPlaybackStart({
    guildId: yGuildId,
    trackId: yTrack2.track.id,
    userId: yUserId,
    trackTitle: 'Midnight Stroll',
    artist: 'Lofi Beats',
    startedAt: yesterdayDate2,
  });
  await analyticsManager.recordPlaybackStart({
    guildId: yGuildId,
    trackId: tTrack.track.id,
    userId: yUserId,
    trackTitle: 'Morning Coffee',
    artist: 'Sunny Day',
    startedAt: todayDate,
  });
  await analyticsManager.recordPlaybackStart({
    guildId: yGuildId,
    trackId: oldTrack.track.id,
    userId: yUserId,
    trackTitle: 'Ancient Echoes',
    artist: 'Oldies',
    startedAt: oldDate,
  });

  // 4.1 Query songs played yesterday
  const yesterdayTracks = await analyticsManager.getTracksPlayedYesterday({
    guildId: yGuildId,
    userId: yUserId,
    referenceDate: todayRef,
  });

  assert(yesterdayTracks.length === 2, 'getTracksPlayedYesterday correctly isolates 2 tracks played yesterday');
  const yTitles = yesterdayTracks.map((t) => t.title);
  assert(yTitles.includes('Neon Highway'), 'Yesterday tracks include "Neon Highway"');
  assert(yTitles.includes('Midnight Stroll'), 'Yesterday tracks include "Midnight Stroll"');
  assert(!yTitles.includes('Morning Coffee'), 'Yesterday tracks strictly exclude songs played today');
  assert(!yTitles.includes('Ancient Echoes'), 'Yesterday tracks strictly exclude songs played 4 days ago');

  // 4.2 Auto-generate yesterday playlist recommendation
  const yPlaylist = await playlistManager.syncYesterdayPlaylist(yGuildId, analyticsManager, {
    userId: yUserId,
    referenceDate: todayRef,
    retentionDays: 2,
  });

  assert(!!yPlaylist, 'syncYesterdayPlaylist creates recommended playlist');
  assert(yPlaylist!.name.includes("Yesterday's Songs"), 'Playlist name contains "Yesterday\'s Songs"');
  assert(yPlaylist!.name.includes('2026-10-11'), 'Playlist name includes yesterday date tag (2026-10-11)');
  assert(yPlaylist!.description?.includes('2-3 days') || false, 'Playlist description indicates 2-3 day auto-deletion');
  assert(yPlaylist!.trackCount === 2, 'Recommended playlist contains 2 tracks from yesterday');

  // 4.3 Verify QuickPlay menu includes yesterday option and button
  const yMenu = await buildQuickPlayMenu(yGuildId, {
    analyticsManager,
    playlistManager,
    trackManager,
    userId: yUserId,
  });

  const allCompButtons = yMenu.components.flatMap((row: any) =>
    row.components.filter((c: any) => c.data.custom_id === 'gakki:qp:yesterday'),
  );
  assert(allCompButtons.length >= 1, 'QuickPlay menu includes dedicated "Play the songs I played yesterday" button');
  const yButton = allCompButtons[0];
  assert(
    yButton.data.label === 'Play the songs I played yesterday',
    'Button has exact label "Play the songs I played yesterday"',
  );

  const playlistSelectComp: any = yMenu.components[1]?.components[0];
  const optionsList = playlistSelectComp?.options || playlistSelectComp?.data?.options || [];
  const ySelectOption = optionsList.find((o: any) =>
    (o.data?.label || o.label || '').includes('Play the songs I played yesterday'),
  );
  assert(!!ySelectOption, 'QuickPlay dropdown includes "Play the songs I played yesterday" option');

  // 4.4 Test interaction on "Play the songs I played yesterday" button
  let yRepliedTitle = '';
  let yRepliedDesc = '';
  const mockYesterdayInteraction: any = {
    guildId: yGuildId,
    customId: 'gakki:qp:yesterday',
    isButton: () => true,
    isStringSelectMenu: () => false,
    deferReply: async () => {},
    editReply: async (msg: any) => {
      yRepliedTitle = msg.embeds?.[0]?.data?.title || '';
      yRepliedDesc = msg.embeds?.[0]?.data?.description || '';
    },
    member: { displayName: 'Tester', voice: { channel: { id: 'vc_123' } } },
    user: { id: yUserId, username: 'Tester' },
    client: { guilds: { fetch: async () => null } },
  };

  await handleQuickPlayInteraction(mockYesterdayInteraction, {
    playbackManager,
    analyticsManager,
    playlistManager,
    trackManager,
    referenceDate: todayRef,
  });

  assert(
    yRepliedTitle.includes('Playing Songs Played Yesterday'),
    'Clicking "Play the songs I played yesterday" button starts yesterday playlist',
  );
  assert(
    yRepliedDesc.includes('2-3 days'),
    'Yesterday playback reply mentions auto-deletion after 2-3 days',
  );

  // 4.5 Test interaction via dropdown "auto:yesterday"
  let yDropdownRepliedTitle = '';
  const mockYesterdayDropdownInteraction: any = {
    guildId: yGuildId,
    customId: 'gakki:qp:select_playlist',
    values: ['auto:yesterday'],
    isButton: () => false,
    isStringSelectMenu: () => true,
    deferReply: async () => {},
    editReply: async (msg: any) => {
      yDropdownRepliedTitle = msg.embeds?.[0]?.data?.title || '';
    },
    member: { displayName: 'Tester', voice: { channel: { id: 'vc_123' } } },
    user: { id: yUserId, username: 'Tester' },
    client: { guilds: { fetch: async () => null } },
  };

  await handleQuickPlayInteraction(mockYesterdayDropdownInteraction, {
    playbackManager,
    analyticsManager,
    playlistManager,
    trackManager,
    referenceDate: todayRef,
  });

  assert(
    yDropdownRepliedTitle.includes('Playing Songs Played Yesterday'),
    'Selecting "auto:yesterday" from dropdown initiates yesterday playback',
  );

  // 4.6 Auto-deletion after 2-3 days verification
  const expiredOldPl = await playlistManager.createPlaylist({
    name: "📅 Yesterday's Songs (2026-10-07)",
    description: '[auto-yesterday:2026-10-07] Old playlist auto-deletes in 2-3 days',
    guildId: yGuildId,
    ownerUserId: yUserId,
  });

  // Manually backdate the createdAt of the old playlist to 3.5 days ago
  const threeDaysAgoMs = Date.now() - 3.5 * 24 * 60 * 60 * 1000;
  expiredOldPl.createdAt = new Date(threeDaysAgoMs).toISOString();

  const purgedCount = await playlistManager.cleanupExpiredPlaylists(2);
  assert(purgedCount >= 1, 'cleanupExpiredPlaylists purges playlists older than 2-3 days');

  const verifyDeleted = await playlistManager.getPlaylist(expiredOldPl.id);
  assert(verifyDeleted === null, 'Expired yesterday playlist is verified deleted from database/memory');

  const activeRecentPl = await playlistManager.getPlaylist(yPlaylist!.id);
  assert(activeRecentPl !== null, 'Active recent yesterday playlist (< 2 days old) is preserved and NOT deleted');

  console.log('\n================================================================');
  console.log('✅ ALL SMART HISTORY, MOST PLAYED & QUICKPLAY TESTS PASSED!');
  console.log('================================================================\n');
  process.exit(0);
}

runTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
