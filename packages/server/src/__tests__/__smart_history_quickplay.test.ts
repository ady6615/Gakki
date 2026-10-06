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

  console.log('\n================================================================');
  console.log('✅ ALL SMART HISTORY, MOST PLAYED & QUICKPLAY TESTS PASSED!');
  console.log('================================================================\n');
  process.exit(0);
}

runTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
