import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
  type GuildMember,
} from 'discord.js';
import {
  HttpAudioSource,
  LocalAudioSource,
  createLogger,
  type PlaybackManager,
  type AudioSourceManager,
  type AnalyticsManager,
  type PlaylistManager,
  type TrackManager,
  type AiRecommendationManager,
  type AudioSource,
} from '@gakki/core';
import * as fs from 'node:fs';
import { probeAudioMetadata } from '../audio/ffmpeg';
import { spawnControlPanelInChannel, refreshPanel } from './control-panel';
import { formatDuration } from './commands';

const logger = createLogger('quickplay-menu');

export interface QuickPlayContext {
  playbackManager: PlaybackManager;
  audioSourceManager?: AudioSourceManager;
  analyticsManager?: AnalyticsManager;
  playlistManager?: PlaylistManager;
  trackManager?: TrackManager;
  recManager?: AiRecommendationManager;
}

/**
 * Builds the interactive QuickPlay / Welcome Menu for Gakki MusicBot.
 * Gives users 1-click options to resume playback, play previous playlists,
 * play recent songs, play same-genre music, or play the most-played songs.
 */
export async function buildQuickPlayMenu(
  guildId: string,
  options: {
    analyticsManager?: AnalyticsManager;
    playlistManager?: PlaylistManager;
    trackManager?: TrackManager;
    recManager?: AiRecommendationManager;
  } = {},
): Promise<{ embeds: EmbedBuilder[]; components: ActionRowBuilder<any>[] }> {
  const { analyticsManager, playlistManager, trackManager } = options;

  let topTracksText = '*No playback history yet*';
  let recentTracksText = '*No recent tracks*';
  let topGenre = 'Pop';
  let playlistsList: Array<{ id: string; name: string; trackCount: number; description: string | null }> = [];
  let distinctGenres: Array<{ genre: string; count: number }> = [];

  // 1. Fetch Analytics for Top Tracks & Recent Tracks
  if (analyticsManager) {
    try {
      const stats = await analyticsManager.getDashboardStats({ guildId, timeRange: 'all' });
      const topTracks = stats.topTracks || stats.mostPlayedTracks || [];
      if (topTracks.length > 0) {
        topTracksText = topTracks
          .slice(0, 3)
          .map((t, idx) => `**${idx + 1}.** ${t.title}${t.artist ? ` — *${t.artist}*` : ''} (\`${t.playCount} plays\`)`)
          .join('\n');
      }

      const recent = await analyticsManager.getRecentTracks(guildId, 3);
      if (recent.length > 0) {
        recentTracksText = recent
          .map((t, idx) => `**${idx + 1}.** ${t.title}${t.artist ? ` — *${t.artist}*` : ''}`)
          .join('\n');
      }
    } catch {
      // ignore
    }
  }

  // 2. Fetch Playlists
  if (playlistManager) {
    try {
      const { userPlaylists, guildPlaylists } = await playlistManager.listPlaylists({ guildId });
      const combined = [...guildPlaylists, ...userPlaylists];
      const seen = new Set<string>();
      for (const p of combined) {
        if (!seen.has(p.id)) {
          seen.add(p.id);
          playlistsList.push(p);
        }
      }
    } catch {
      // ignore
    }
  }

  // 3. Fetch Distinct Genres
  if (trackManager) {
    try {
      distinctGenres = await trackManager.getDistinctGenres();
      if (distinctGenres.length > 0) {
        topGenre = distinctGenres[0].genre;
      }
    } catch {
      // ignore
    }
  }

  // ── Build Embed ──────────────────────────────────────────────────
  const embed = new EmbedBuilder()
    .setTitle('⚡ Welcome Back! QuickPlay Music Menu')
    .setDescription(
      'Ready to jump back into the music? Pick an instant playback option below, resume your favorite playlists, or discover smart mixes!',
    )
    .setColor(0x5865f2)
    .addFields(
      {
        name: '🔥 Most Played Songs',
        value: topTracksText,
        inline: false,
      },
      {
        name: '⏪ Recent Songs',
        value: recentTracksText,
        inline: true,
      },
      {
        name: '🎧 Popular Genre',
        value: `**${topGenre}** (${distinctGenres[0]?.count || 0} tracks)`,
        inline: true,
      },
    )
    .setFooter({
      text: 'Gakki Music Platform • Zero-latency streaming & intelligent history',
    })
    .setTimestamp();

  // ── Build Action Rows ───────────────────────────────────────────
  const components: ActionRowBuilder<any>[] = [];

  // Row 1: Instant QuickPlay Buttons
  const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('gakki:qp:most_played')
      .setLabel('Most Played')
      .setEmoji('🔥')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('gakki:qp:recent')
      .setLabel('Recent Songs')
      .setEmoji('⏪')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('gakki:qp:genre_mix')
      .setLabel(`${topGenre} Mix`)
      .setEmoji('🎧')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('gakki:qp:smart_mix')
      .setLabel('Smart Vibe')
      .setEmoji('🎲')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('gakki:qp:panel')
      .setLabel('Player Panel')
      .setEmoji('🎛️')
      .setStyle(ButtonStyle.Secondary),
  );
  components.push(buttonRow);

  // Row 2: Playlist Selection Dropdown (if playlists exist)
  if (playlistsList.length > 0) {
    const playlistOptions = playlistsList.slice(0, 25).map((p) =>
      new StringSelectMenuOptionBuilder()
        .setLabel(p.name.slice(0, 100))
        .setValue(`pl:${p.id}`)
        .setDescription(
          `${p.trackCount} track(s)${p.description ? ` • ${p.description.slice(0, 60)}` : ''}`,
        )
        .setEmoji('📜'),
    );

    const playlistSelect = new StringSelectMenuBuilder()
      .setCustomId('gakki:qp:select_playlist')
      .setPlaceholder('📜 Select a Previous Playlist to Play...')
      .addOptions(playlistOptions);

    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(playlistSelect));
  }

  // Row 3: Genre Mix Dropdown (if genres exist)
  if (distinctGenres.length > 0) {
    const genreOptions = distinctGenres.slice(0, 25).map((g) =>
      new StringSelectMenuOptionBuilder()
        .setLabel(`${g.genre} Mix`)
        .setValue(`genre:${g.genre}`)
        .setDescription(`${g.count} track(s) in library`)
        .setEmoji('🎵'),
    );

    const genreSelect = new StringSelectMenuBuilder()
      .setCustomId('gakki:qp:select_genre')
      .setPlaceholder('🎧 Pick a Genre Mix to Stream...')
      .addOptions(genreOptions);

    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(genreSelect));
  }

  return { embeds: [embed], components };
}

/**
 * Helper to ensure the bot is connected to the user's voice channel.
 */
async function ensureVoiceConnected(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  playbackManager: PlaybackManager,
): Promise<boolean> {
  const guildId = interaction.guildId;
  if (!guildId) return false;

  const guild = interaction.guild ?? (await interaction.client.guilds.fetch(guildId).catch(() => null));
  let member = interaction.member as GuildMember;
  if ((!member || !member.voice) && guild) {
    member = (await guild.members.fetch(interaction.user.id).catch(() => member)) as any;
  }

  const userVoiceChannel = member?.voice?.channel;
  const currentState = playbackManager.getState(guildId);

  if (currentState.voiceState !== 'CONNECTED') {
    if (!userVoiceChannel) {
      await interaction.editReply('⚠️ You must join a voice channel first to play music.');
      return false;
    }
    try {
      await playbackManager.join(guildId, userVoiceChannel.id);
    } catch (err: any) {
      await interaction.editReply(`❌ Failed to join voice channel: ${err.message}`);
      return false;
    }
  }

  return true;
}

/**
 * Handles all QuickPlay button and select menu interactions (prefixed with `gakki:qp:`).
 */
export async function handleQuickPlayInteraction(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  context: QuickPlayContext,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) return;

  const { playbackManager, analyticsManager, playlistManager, trackManager, recManager, audioSourceManager } = context;
  const customId = interaction.customId;
  const userTag = (interaction.member as GuildMember)?.displayName || interaction.user.username;

  // 1. Player Panel button handler
  if (customId === 'gakki:qp:panel') {
    await interaction.deferReply({ ephemeral: true });
    if (interaction.channel) {
      await spawnControlPanelInChannel(interaction.channel, guildId, playbackManager);
      await interaction.editReply('🎛️ Control panel spawned below!');
    } else {
      await interaction.editReply('❌ Could not spawn control panel in this channel.');
    }
    return;
  }

  await interaction.deferReply();

  const connected = await ensureVoiceConnected(interaction, playbackManager);
  if (!connected) return;

  try {
    // ── 2. Most Played Button ─────────────────────────────────────────
    if (customId === 'gakki:qp:most_played') {
      let tracksToPlay: Array<{
        title: string;
        artist?: string | null;
        album?: string | null;
        duration?: number | null;
        sourceUrl?: string | null;
        provider?: string | null;
      }> = [];

      if (playlistManager && analyticsManager) {
        const mostPlayedPl = await playlistManager.syncMostPlayedPlaylist(guildId, analyticsManager, 25);
        const plDetails = await playlistManager.getPlaylist(mostPlayedPl.id);
        if (plDetails && plDetails.tracks.length > 0) {
          tracksToPlay = plDetails.tracks
            .filter((pt) => !!pt.track || !!pt.source)
            .map((pt) => ({
              title: pt.track?.title || 'Unknown Track',
              artist: pt.track?.artist ?? null,
              album: pt.track?.album ?? null,
              duration: pt.track?.duration ?? null,
              sourceUrl: pt.source?.sourceUrl || (pt.track?.artist ? `${pt.track.artist} - ${pt.track.title}` : pt.track?.title) || 'Unknown',
              provider: pt.source?.provider || 'youtube',
            }));
        }
      }

      if (tracksToPlay.length === 0 && analyticsManager) {
        const stats = await analyticsManager.getDashboardStats({ guildId, timeRange: 'all' });
        const top = stats.topTracks || stats.mostPlayedTracks || [];
        tracksToPlay = await Promise.all(
          top.map(async (t) => {
            let srcUrl: string | null = null;
            let provider = 'youtube';
            if (trackManager && t.trackId) {
              const src = await trackManager.getPrimarySourceByTrackId(t.trackId).catch(() => null);
              if (src?.sourceUrl) {
                srcUrl = src.sourceUrl;
                provider = src.provider;
              }
            }
            return {
              title: t.title,
              artist: t.artist,
              album: null,
              duration: t.duration,
              sourceUrl: srcUrl || (t.artist ? `${t.artist} - ${t.title}` : t.title),
              provider,
            };
          }),
        );
      }

      if (tracksToPlay.length === 0) {
        await interaction.editReply('ℹ️ No playback history found yet for this server. Play some songs first!');
        return;
      }

      // Enqueue and start playing
      await playTrackList(guildId, tracksToPlay, playbackManager, userTag, interaction.user.id, audioSourceManager);

      const embed = new EmbedBuilder()
        .setTitle('🔥 Playing Most Played Playlist')
        .setDescription(
          `Loaded **${tracksToPlay.length}** most played tracks into the queue.\n` +
          `▶️ **Now Playing:** **${tracksToPlay[0].title}**${tracksToPlay[0].artist ? ` by *${tracksToPlay[0].artist}*` : ''}`,
        )
        .setColor(0xe11d48)
        .setFooter({ text: `Triggered by ${userTag}` });

      await interaction.editReply({ embeds: [embed] });
      await refreshPanel(guildId, playbackManager).catch(() => {});
      return;
    }

    // ── 3. Recent Songs Button ────────────────────────────────────────
    if (customId === 'gakki:qp:recent') {
      let recentTracks: Array<{
        title: string;
        artist?: string | null;
        duration?: number | null;
        sourceUrl?: string | null;
        provider?: string | null;
      }> = [];

      if (analyticsManager) {
        const recent = await analyticsManager.getRecentTracks(guildId, 15);
        if (recent.length > 0) {
          recentTracks = await Promise.all(
            recent.map(async (r) => {
              let srcUrl: string | null = null;
              let provider = 'youtube';
              if (trackManager && r.trackId) {
                const src = await trackManager.getPrimarySourceByTrackId(r.trackId).catch(() => null);
                if (src?.sourceUrl) {
                  srcUrl = src.sourceUrl;
                  provider = src.provider;
                }
              }
              return {
                title: r.title,
                artist: r.artist,
                duration: null,
                sourceUrl: srcUrl || (r.artist ? `${r.artist} - ${r.title}` : r.title),
                provider,
              };
            }),
          );
        }
      }

      if (recentTracks.length === 0 && trackManager) {
        const libraryRecent = await trackManager.getRecentTracks(15);
        recentTracks = libraryRecent.map((t) => ({
          title: t.title,
          artist: t.artist,
          duration: t.duration,
          sourceUrl: t.source?.sourceUrl || (t.artist ? `${t.artist} - ${t.title}` : t.title),
          provider: t.source?.provider || 'local',
        }));
      }

      if (recentTracks.length === 0) {
        await interaction.editReply('ℹ️ No recent tracks found in this server.');
        return;
      }

      await playTrackList(guildId, recentTracks, playbackManager, userTag, interaction.user.id, audioSourceManager);

      const embed = new EmbedBuilder()
        .setTitle('⏪ Playing Recent Songs')
        .setDescription(
          `Enqueued **${recentTracks.length}** recently played tracks.\n` +
          `▶️ **Now Playing:** **${recentTracks[0].title}**${recentTracks[0].artist ? ` by *${recentTracks[0].artist}*` : ''}`,
        )
        .setColor(0x3b82f6)
        .setFooter({ text: `Triggered by ${userTag}` });

      await interaction.editReply({ embeds: [embed] });
      await refreshPanel(guildId, playbackManager).catch(() => {});
      return;
    }

    // ── 4. Same Genre Mix Button ──────────────────────────────────────
    if (customId === 'gakki:qp:genre_mix') {
      let targetGenre = 'Pop';
      if (trackManager) {
        const genres = await trackManager.getDistinctGenres();
        if (genres.length > 0) {
          targetGenre = genres[0].genre;
        }
      }

      let genreTracks: Array<{
        title: string;
        artist?: string | null;
        album?: string | null;
        duration?: number | null;
        sourceUrl?: string | null;
        provider?: string | null;
      }> = [];

      if (trackManager) {
        const fetched = await trackManager.getTracksByGenre(targetGenre, 20);
        genreTracks = fetched.map((t) => ({
          title: t.title,
          artist: t.artist,
          album: t.album,
          duration: t.duration,
          sourceUrl: t.source?.sourceUrl || (t.artist ? `${t.artist} - ${t.title}` : t.title),
          provider: t.source?.provider || 'local',
        }));
      }

      if (genreTracks.length === 0) {
        await interaction.editReply(`ℹ️ No tracks found for genre **${targetGenre}**.`);
        return;
      }

      await playTrackList(guildId, genreTracks, playbackManager, userTag, interaction.user.id, audioSourceManager);

      const embed = new EmbedBuilder()
        .setTitle(`🎧 Playing ${targetGenre} Genre Mix`)
        .setDescription(
          `Enqueued **${genreTracks.length}** tracks matching **${targetGenre}**.\n` +
          `▶️ **Now Playing:** **${genreTracks[0].title}**${genreTracks[0].artist ? ` by *${genreTracks[0].artist}*` : ''}`,
        )
        .setColor(0x8b5cf6)
        .setFooter({ text: `Triggered by ${userTag}` });

      await interaction.editReply({ embeds: [embed] });
      await refreshPanel(guildId, playbackManager).catch(() => {});
      return;
    }

    // ── 5. Smart Vibe Mix Button ──────────────────────────────────────
    if (customId === 'gakki:qp:smart_mix') {
      let vibeTracks: Array<{
        title: string;
        artist?: string | null;
        duration?: number | null;
        sourceUrl?: string | null;
        provider?: string | null;
      }> = [];

      if (recManager) {
        try {
          let seedTrackId: string | undefined;
          if (analyticsManager) {
            const recent = await analyticsManager.getRecentTracks(guildId, 1);
            if (recent.length > 0) {
              seedTrackId = recent[0].trackId;
            }
          }
          if (!seedTrackId && trackManager) {
            const all = await trackManager.getAllTracks(1);
            if (all.length > 0) {
              seedTrackId = all[0].id;
            }
          }

          if (seedTrackId) {
            const recResult = await recManager.generateVibePlaylist(seedTrackId, guildId, 15, 'BALANCED');
            vibeTracks = recResult.tracks.map((r: any) => ({
              title: r.title || r.name,
              artist: r.artist ?? null,
              duration: r.duration ?? null,
              sourceUrl: r.path || r.sourceUrl || (r.artist ? `${r.artist} - ${r.title || r.name}` : r.title || r.name),
              provider: r.sourceProvider || 'youtube',
            }));
          }
        } catch {
          // ignore
        }
      }

      if (vibeTracks.length === 0 && trackManager) {
        const all = await trackManager.getAllTracks(25);
        // Shuffle
        const shuffled = [...all].sort(() => Math.random() - 0.5).slice(0, 15);
        vibeTracks = await Promise.all(
          shuffled.map(async (t) => {
            let srcUrl: string | null = null;
            let provider = 'local';
            const src = await trackManager.getPrimarySourceByTrackId(t.id).catch(() => null);
            if (src?.sourceUrl) {
              srcUrl = src.sourceUrl;
              provider = src.provider;
            }
            return {
              title: t.title,
              artist: t.artist,
              duration: t.duration,
              sourceUrl: srcUrl || (t.artist ? `${t.artist} - ${t.title}` : t.title),
              provider,
            };
          }),
        );
      }

      if (vibeTracks.length === 0) {
        await interaction.editReply('ℹ️ Not enough music data to construct a smart vibe mix yet.');
        return;
      }

      await playTrackList(guildId, vibeTracks, playbackManager, userTag, interaction.user.id, audioSourceManager);

      const embed = new EmbedBuilder()
        .setTitle('🎲 Playing Smart Vibe Mix')
        .setDescription(
          `Generated **${vibeTracks.length}** personalized tracks.\n` +
          `▶️ **Now Playing:** **${vibeTracks[0].title}**${vibeTracks[0].artist ? ` by *${vibeTracks[0].artist}*` : ''}`,
        )
        .setColor(0x10b981)
        .setFooter({ text: `Triggered by ${userTag}` });

      await interaction.editReply({ embeds: [embed] });
      await refreshPanel(guildId, playbackManager).catch(() => {});
      return;
    }

    // ── 6. Select Playlist Dropdown ────────────────────────────────────
    if (interaction.isStringSelectMenu() && customId === 'gakki:qp:select_playlist') {
      const selectedValue = interaction.values[0];
      const playlistId = selectedValue.replace('pl:', '');

      if (!playlistManager) {
        await interaction.editReply('❌ Playlist manager is not available.');
        return;
      }

      const plData = await playlistManager.getPlaylist(playlistId);
      if (!plData || plData.tracks.length === 0) {
        await interaction.editReply('❌ Selected playlist is empty or could not be found.');
        return;
      }

      const tracksToPlay = plData.tracks
        .filter((pt) => !!pt.track || !!pt.source)
        .map((pt) => ({
          title: pt.track?.title || 'Unknown Track',
          artist: pt.track?.artist ?? null,
          album: pt.track?.album ?? null,
          duration: pt.track?.duration ?? null,
          sourceUrl: pt.source?.sourceUrl || (pt.track?.artist ? `${pt.track.artist} - ${pt.track.title}` : pt.track?.title) || 'Unknown',
          provider: pt.source?.provider || 'youtube',
          thumbnailUrl: pt.track?.coverArt ?? null,
        }));

      if (tracksToPlay.length === 0) {
        await interaction.editReply('❌ No valid tracks found in selected playlist.');
        return;
      }

      await playTrackList(guildId, tracksToPlay, playbackManager, userTag, interaction.user.id, audioSourceManager);

      const embed = new EmbedBuilder()
        .setTitle(`📜 Playing Playlist: ${plData.playlist.name}`)
        .setDescription(
          `Loaded **${tracksToPlay.length}** tracks into queue.\n` +
          `▶️ **Now Playing:** **${tracksToPlay[0].title}**${tracksToPlay[0].artist ? ` by *${tracksToPlay[0].artist}*` : ''}`,
        )
        .setColor(0x06b6d4)
        .setFooter({ text: `Selected by ${userTag}` });

      await interaction.editReply({ embeds: [embed] });
      await refreshPanel(guildId, playbackManager).catch(() => {});
      return;
    }

    // ── 7. Select Genre Dropdown ───────────────────────────────────────
    if (interaction.isStringSelectMenu() && customId === 'gakki:qp:select_genre') {
      const selectedValue = interaction.values[0];
      const genreName = selectedValue.replace('genre:', '');

      if (!trackManager) {
        await interaction.editReply('❌ Track manager is not available.');
        return;
      }

      const fetched = await trackManager.getTracksByGenre(genreName, 20);
      if (fetched.length === 0) {
        await interaction.editReply(`ℹ️ No tracks found for genre **${genreName}**.`);
        return;
      }

      const tracksToPlay = fetched.map((t) => ({
        title: t.title,
        artist: t.artist,
        album: t.album,
        duration: t.duration,
        sourceUrl: t.source?.sourceUrl || (t.artist ? `${t.artist} - ${t.title}` : t.title),
        provider: t.source?.provider || 'local',
      }));

      await playTrackList(guildId, tracksToPlay, playbackManager, userTag, interaction.user.id, audioSourceManager);

      const embed = new EmbedBuilder()
        .setTitle(`🎵 Playing ${genreName} Mix`)
        .setDescription(
          `Enqueued **${tracksToPlay.length}** tracks in genre **${genreName}**.\n` +
          `▶️ **Now Playing:** **${tracksToPlay[0].title}**${tracksToPlay[0].artist ? ` by *${tracksToPlay[0].artist}*` : ''}`,
        )
        .setColor(0xec4899)
        .setFooter({ text: `Selected by ${userTag}` });

      await interaction.editReply({ embeds: [embed] });
      await refreshPanel(guildId, playbackManager).catch(() => {});
      return;
    }
  } catch (err: any) {
    logger.error({ err, customId, guildId }, 'Error handling QuickPlay interaction');
    await interaction.editReply(`❌ QuickPlay Error: ${err.message}`);
  }
}

/**
 * Helper to enqueue a track list and start playing the first one.
 */
async function playTrackList(
  guildId: string,
  tracks: Array<{
    title: string;
    artist?: string | null;
    album?: string | null;
    duration?: number | null;
    sourceUrl?: string | null;
    provider?: string | null;
    thumbnailUrl?: string | null;
  }>,
  playbackManager: PlaybackManager,
  addedBy: string,
  userId: string,
  audioSourceManager?: AudioSourceManager,
): Promise<void> {
  if (tracks.length === 0) return;

  const first = tracks[0];
  const firstPath = first.sourceUrl || (first.artist ? `${first.artist} - ${first.title}` : first.title);

  let firstSource: AudioSource;
  if (firstPath.startsWith('http://') || firstPath.startsWith('https://')) {
    if (audioSourceManager && audioSourceManager.canHandle(firstPath)) {
      try {
        const resolved = await audioSourceManager.resolve(firstPath);
        if (resolved.isStream || resolved.streamUrlOrPath.startsWith('http')) {
          firstSource = new HttpAudioSource(resolved.streamUrlOrPath, resolved.metadata);
        } else {
          firstSource = new LocalAudioSource(resolved.streamUrlOrPath, undefined, probeAudioMetadata);
        }
      } catch {
        firstSource = new HttpAudioSource(firstPath, {
          title: first.title,
          artist: first.artist ?? null,
          album: first.album ?? null,
          duration: first.duration ?? null,
        });
      }
    } else {
      firstSource = new HttpAudioSource(firstPath, {
        title: first.title,
        artist: first.artist ?? null,
        album: first.album ?? null,
        duration: first.duration ?? null,
      });
    }
  } else if (fs.existsSync(firstPath)) {
    firstSource = new LocalAudioSource(firstPath, undefined, probeAudioMetadata);
  } else if (audioSourceManager) {
    const query = firstPath.startsWith('ytsearch:') ? firstPath : `ytsearch:${firstPath}`;
    try {
      const resolved = await audioSourceManager.resolve(query);
      if (resolved.isStream || resolved.streamUrlOrPath.startsWith('http')) {
        firstSource = new HttpAudioSource(resolved.streamUrlOrPath, resolved.metadata);
      } else {
        firstSource = new LocalAudioSource(resolved.streamUrlOrPath, undefined, probeAudioMetadata);
      }
    } catch {
      firstSource = new LocalAudioSource(firstPath, undefined, probeAudioMetadata);
    }
  } else {
    firstSource = new LocalAudioSource(firstPath, undefined, probeAudioMetadata);
  }

  // Play the first track immediately
  await playbackManager.play(guildId, firstSource, {
    name: first.title,
    path: firstPath,
    duration: first.duration ?? undefined,
    artist: first.artist ?? undefined,
    album: first.album ?? undefined,
    thumbnailUrl: first.thumbnailUrl ?? undefined,
    sourceProvider: first.provider || 'Library',
    sourceUrl: first.sourceUrl ?? undefined,
    addedBy,
    userId,
  });

  // Enqueue the rest
  for (let i = 1; i < tracks.length; i++) {
    const t = tracks[i];
    const tPath = t.sourceUrl || (t.artist ? `${t.artist} - ${t.title}` : t.title);
    playbackManager.queueManager.enqueue(guildId, {
      name: t.title,
      path: tPath,
      duration: t.duration ?? undefined,
      artist: t.artist ?? undefined,
      album: t.album ?? undefined,
      thumbnailUrl: t.thumbnailUrl ?? undefined,
      sourceProvider: t.provider || 'Library',
      sourceUrl: t.sourceUrl ?? undefined,
      addedBy,
      userId,
    });
  }
}
