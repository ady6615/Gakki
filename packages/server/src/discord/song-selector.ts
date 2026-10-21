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
  PermissionsBitField,
} from 'discord.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  SUPPORTED_AUDIO_EXTENSIONS,
  resolveMusicStorageDir,
  createLogger,
  HttpAudioSource,
  LocalAudioSource,
  type AudioSourceManager,
  type PlaybackManager,
  type TrackManager,
  type AudioSource,
  type QueueTrack,
} from '@gakki/core';
import { probeAudioMetadata } from '../audio/ffmpeg';
import { isAudioFolder } from '../audio/batch-loader';
import { refreshPanel } from './control-panel';
import { formatDuration } from './commands';
import { createConfiguredAudioSourceManager } from '../sources';
import { resolveAnyAudioInput } from '../audio/track-resolver';

const logger = createLogger('song-selector');

export type AudioInputPredictionType = 'link' | 'folder_path' | 'file_path' | 'song_name';

export interface AudioInputPrediction {
  type: AudioInputPredictionType;
  value: string;
  confidence: number;
  details?: string;
}

export interface SongCandidate {
  id: string;
  title: string;
  artist?: string | null;
  album?: string | null;
  duration?: number | null;
  sourceUrl: string;
  sourceProvider: string;
  thumbnailUrl?: string | null;
}

export interface SongChoiceSession {
  id: string;
  guildId: string;
  userId: string;
  userName: string;
  songName: string;
  isPlayNext: boolean;
  candidates: SongCandidate[];
  createdAt: number;
  timeoutId: NodeJS.Timeout;
}

/**
 * In-memory registry of active song selection sessions.
 */
const songChoiceSessions = new Map<string, SongChoiceSession>();

/**
 * Predict whether the raw user input is:
 * 1. A link (Spotify, YouTube, SoundCloud, HTTP/HTTPS audio URL)
 * 2. A folder path (storage/music subfolder or local directory)
 * 3. A file path (explicit audio file on disk)
 * 4. A song name / query
 */
export function predictAudioInputType(rawInput: string, customMusicDir?: string): AudioInputPrediction {
  const input = rawInput.trim();
  const musicDir = customMusicDir || resolveMusicStorageDir();

  // 1. Link Detection (HTTP / HTTPS / Spotify URI / SoundCloud / YouTube)
  if (
    input.startsWith('http://') ||
    input.startsWith('https://') ||
    input.startsWith('spotify:') ||
    /^www\./i.test(input) ||
    /^(https?:\/\/)?(www\.)?(open\.spotify\.com|youtube\.com|youtu\.be|soundcloud\.com)/i.test(input)
  ) {
    return {
      type: 'link',
      value: input,
      confidence: 1.0,
      details: 'Detected web or streaming URL',
    };
  }

  // 2. Folder Path Detection
  // Check if directory exists on filesystem directly
  if (path.isAbsolute(input) && fs.existsSync(input)) {
    try {
      const stat = fs.statSync(input);
      if (stat.isDirectory()) {
        return {
          type: 'folder_path',
          value: input,
          confidence: 1.0,
          details: 'Absolute directory path on filesystem',
        };
      }
    } catch {
      // ignore
    }
  }

  // Check if directory in storage/music
  const folderInMusicDir = path.resolve(musicDir, input);
  if (fs.existsSync(folderInMusicDir)) {
    try {
      const stat = fs.statSync(folderInMusicDir);
      if (stat.isDirectory()) {
        return {
          type: 'folder_path',
          value: input,
          confidence: 1.0,
          details: 'Folder inside storage/music',
        };
      }
    } catch {
      // ignore
    }
  }

  // Check if batch-loader identifies it as audio folder
  if (isAudioFolder(input)) {
    return {
      type: 'folder_path',
      value: input,
      confidence: 0.95,
      details: 'Recognized audio folder',
    };
  }

  // 3. File Path Detection
  // Direct file check (absolute)
  if (path.isAbsolute(input) && fs.existsSync(input)) {
    try {
      const stat = fs.statSync(input);
      if (stat.isFile()) {
        return {
          type: 'file_path',
          value: input,
          confidence: 1.0,
          details: 'Existing absolute file path',
        };
      }
    } catch {
      // ignore
    }
  }

  // Direct file check (relative to storage/music)
  const fileInMusicDir = path.resolve(musicDir, input);
  if (fs.existsSync(fileInMusicDir)) {
    try {
      const stat = fs.statSync(fileInMusicDir);
      if (stat.isFile()) {
        return {
          type: 'file_path',
          value: input,
          confidence: 1.0,
          details: 'Existing file in storage/music',
        };
      }
    } catch {
      // ignore
    }
  }

  // Appending supported extensions in storage/music
  for (const ext of SUPPORTED_AUDIO_EXTENSIONS) {
    const candidatePath = path.resolve(musicDir, `${input}${ext}`);
    if (fs.existsSync(candidatePath)) {
      try {
        const stat = fs.statSync(candidatePath);
        if (stat.isFile()) {
          return {
            type: 'file_path',
            value: `${input}${ext}`,
            confidence: 0.95,
            details: `Found audio file with extension ${ext}`,
          };
        }
      } catch {
        // ignore
      }
    }
  }

  // Check if input has audio extension and path separators or is explicitly formatted as filename
  const lowerExt = path.extname(input).toLowerCase();
  if (SUPPORTED_AUDIO_EXTENSIONS.includes(lowerExt as any)) {
    return {
      type: 'file_path',
      value: input,
      confidence: 0.85,
      details: 'Explicit audio file name/path pattern',
    };
  }

  // 4. Default: Song Name / Search Query
  return {
    type: 'song_name',
    value: input,
    confidence: 0.9,
    details: 'User provided song title or keywords',
  };
}

/**
 * Searches for songs matching a song name across local files, database, and online providers.
 */
export async function searchSongsUniversally(
  songName: string,
  options: {
    audioSourceManager?: AudioSourceManager;
    trackManager?: TrackManager;
    musicDir?: string;
    limit?: number;
  } = {},
): Promise<SongCandidate[]> {
  const query = songName.trim();
  const limit = options.limit || 8;
  const musicDir = options.musicDir || resolveMusicStorageDir();
  const candidates: SongCandidate[] = [];
  const seenUrls = new Set<string>();

  // 1. Search Local Storage Directory
  if (fs.existsSync(musicDir)) {
    try {
      const cleanQ = query.toLowerCase().replace(/[^a-z0-9]/g, '');
      const files = fs.readdirSync(musicDir, { withFileTypes: true });

      for (const f of files) {
        if (!f.isFile()) continue;
        const ext = path.extname(f.name).toLowerCase();
        if (!SUPPORTED_AUDIO_EXTENSIONS.includes(ext as any)) continue;

        const baseName = path.basename(f.name, ext);
        const cleanBase = baseName.toLowerCase().replace(/[^a-z0-9]/g, '');

        if (cleanBase.includes(cleanQ) || cleanQ.includes(cleanBase) || baseName.toLowerCase().includes(query.toLowerCase())) {
          let duration: number | null = null;
          let title = baseName;
          let artist: string | null = null;
          let album: string | null = null;

          try {
            const probed = await probeAudioMetadata(path.join(musicDir, f.name));
            if (probed.title) title = probed.title;
            if (probed.artist) artist = probed.artist;
            if (probed.album) album = probed.album;
            if (probed.duration) duration = probed.duration;
          } catch {
            // fallback to filename
          }

          const localUrl = f.name;
          if (!seenUrls.has(localUrl)) {
            seenUrls.add(localUrl);
            candidates.push({
              id: `local:${f.name}`,
              title,
              artist: artist || 'Local Library',
              album,
              duration,
              sourceUrl: localUrl,
              sourceProvider: 'local',
            });
          }

          if (candidates.length >= limit) break;
        }
      }
    } catch (err) {
      logger.debug({ err }, '[SEARCH] Local directory search encountered error');
    }
  }

  // 2. Search Database Tracks if available
  if (options.trackManager && candidates.length < limit) {
    try {
      const dbTracks = await options.trackManager.search(query, limit);
      for (const t of dbTracks) {
        const primarySource = await options.trackManager.getPrimarySourceByTrackId(t.id).catch(() => null);
        const srcUrl = primarySource?.sourceUrl || t.title;
        if (!seenUrls.has(srcUrl)) {
          seenUrls.add(srcUrl);
          candidates.push({
            id: `db:${t.id}`,
            title: t.title,
            artist: t.artist ?? null,
            album: t.album ?? null,
            duration: t.duration ?? null,
            sourceUrl: srcUrl,
            sourceProvider: primarySource?.provider || 'database',
          });
        }
        if (candidates.length >= limit) break;
      }
    } catch (err) {
      logger.debug({ err }, '[SEARCH] Track manager search encountered error');
    }
  }

  // 3. Search Online Providers via AudioSourceManager
  if (options.audioSourceManager && candidates.length < limit) {
    try {
      const remainingLimit = limit - candidates.length;
      const onlineResults = await options.audioSourceManager.search(query, { limit: remainingLimit });
      for (const res of onlineResults) {
        if (!seenUrls.has(res.sourceUrl)) {
          seenUrls.add(res.sourceUrl);
          candidates.push({
            id: `online:${res.provider}:${res.sourceUrl}`,
            title: res.title,
            artist: res.artist ?? null,
            album: res.album ?? null,
            duration: res.duration ?? null,
            sourceUrl: res.sourceUrl,
            sourceProvider: res.provider,
            thumbnailUrl: res.thumbnailUrl ?? null,
          });
        }
        if (candidates.length >= limit) break;
      }
    } catch (err) {
      logger.debug({ err }, '[SEARCH] Online audio search encountered error');
    }
  }

  return candidates;
}

/**
 * Builds an interactive Discord message (Embed + Select Menu + Buttons)
 * allowing the user to click which song they want to play.
 */
export function buildSongChoiceMessage(
  songName: string,
  candidates: SongCandidate[],
  sessionId: string,
  isPlayNext: boolean = false,
): { embeds: EmbedBuilder[]; components: ActionRowBuilder<any>[] } {
  const embed = new EmbedBuilder()
    .setTitle(`🔎 Multiple Songs Found for "${songName}"`)
    .setDescription(
      `Found **${candidates.length}** songs matching "**${songName}**".\n` +
      `Click a song from the dropdown menu or button below to play ${isPlayNext ? 'next' : 'now'}:\n\n` +
      candidates.slice(0, 10).map((c, i) => {
        const dur = c.duration ? ` \`[${formatDuration(c.duration)}]\`` : '';
        const art = c.artist ? ` — *${c.artist}*` : '';
        const prov = c.sourceProvider ? ` • *${c.sourceProvider.toUpperCase()}*` : '';
        return `**${i + 1}.** **${c.title}**${art}${dur}${prov}`;
      }).join('\n')
    )
    .setColor(0x8b5cf6)
    .setFooter({ text: 'Selection expires in 5 minutes • Click below to play' });

  const components: ActionRowBuilder<any>[] = [];

  // Dropdown Select Menu
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`gakki:play_select:${sessionId}`)
    .setPlaceholder('🎵 Click to choose the exact song to play...');

  candidates.slice(0, 25).forEach((c, i) => {
    const label = `${i + 1}. ${c.title}`.slice(0, 100);
    const descParts: string[] = [];
    if (c.artist) descParts.push(c.artist);
    if (c.duration) descParts.push(formatDuration(c.duration));
    if (c.sourceProvider) descParts.push(c.sourceProvider);
    const description = descParts.join(' • ').slice(0, 100) || 'Audio track';

    selectMenu.addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel(label)
        .setDescription(description)
        .setValue(`${i}`)
        .setEmoji(c.sourceProvider === 'local' ? '💿' : '▶️'),
    );
  });

  components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu));

  // Quick Action Click Buttons (up to 5 buttons in the row)
  const buttonLimit = Math.min(candidates.length, 5);
  if (buttonLimit > 0) {
    const buttonRow = new ActionRowBuilder<ButtonBuilder>();
    for (let i = 0; i < buttonLimit; i++) {
      buttonRow.addComponents(
        new ButtonBuilder()
          .setCustomId(`gakki:play_pick:${sessionId}:${i}`)
          .setLabel(`Song ${i + 1}`)
          .setStyle(i === 0 ? ButtonStyle.Success : ButtonStyle.Primary)
          .setEmoji('▶️'),
      );
    }
    components.push(buttonRow);
  }

  return { embeds: [embed], components };
}

/**
 * Stores a selection session in memory with a 5-minute timeout.
 */
export function storeSongChoiceSession(
  sessionId: string,
  sessionData: Omit<SongChoiceSession, 'id' | 'createdAt' | 'timeoutId'>,
): void {
  // Clear any existing session with this ID
  const existing = songChoiceSessions.get(sessionId);
  if (existing) {
    clearTimeout(existing.timeoutId);
    songChoiceSessions.delete(sessionId);
  }

  const timeoutId = setTimeout(() => {
    songChoiceSessions.delete(sessionId);
    logger.debug({ sessionId }, '[SESSION] Expired song choice session');
  }, 300_000); // 5 minutes

  songChoiceSessions.set(sessionId, {
    ...sessionData,
    id: sessionId,
    createdAt: Date.now(),
    timeoutId,
  });
}

/**
 * Retrieves a song choice session by ID.
 */
export function getSongChoiceSession(sessionId: string): SongChoiceSession | undefined {
  return songChoiceSessions.get(sessionId);
}

/**
 * Removes a song choice session.
 */
export function removeSongChoiceSession(sessionId: string): void {
  const session = songChoiceSessions.get(sessionId);
  if (session) {
    clearTimeout(session.timeoutId);
    songChoiceSessions.delete(sessionId);
  }
}

/**
 * Handles incoming button clicks and select menu interactions for song choice.
 */
export async function handleSongChoiceInteraction(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  context: {
    playbackManager: PlaybackManager;
    audioSourceManager?: AudioSourceManager;
    trackManager?: TrackManager;
  },
): Promise<void> {
  const customId = interaction.customId;
  let sessionId = '';
  let selectedIndex = -1;

  if (interaction.isStringSelectMenu() && customId.startsWith('gakki:play_select:')) {
    sessionId = customId.replace('gakki:play_select:', '');
    selectedIndex = parseInt(interaction.values[0], 10);
  } else if (interaction.isButton() && customId.startsWith('gakki:play_pick:')) {
    const parts = customId.split(':'); // ['gakki', 'play_pick', sessionId, index]
    sessionId = parts[2];
    selectedIndex = parseInt(parts[3], 10);
  } else {
    return;
  }

  const session = getSongChoiceSession(sessionId);
  if (!session) {
    await interaction.reply({
      content: '⚠️ This song selection has expired. Please type `/play <song_name>` again.',
      ephemeral: true,
    });
    return;
  }

  const chosen = session.candidates[selectedIndex];
  if (!chosen) {
    await interaction.reply({
      content: '⚠️ Invalid selection index. Please try again.',
      ephemeral: true,
    });
    return;
  }

  // Defer update to avoid timeout
  await interaction.deferUpdate();

  const guildId = session.guildId;
  const { playbackManager, audioSourceManager } = context;

  // Ensure user is connected to voice
  const guild = interaction.guild ?? (await interaction.client.guilds.fetch(guildId).catch(() => null));
  let member = interaction.member as GuildMember;
  if ((!member || !member.voice) && guild) {
    member = (await guild.members.fetch(interaction.user.id).catch(() => member)) as any;
  }

  const userVoiceChannel = member?.voice?.channel;
  const currentState = playbackManager.getState(guildId);

  if (currentState.voiceState !== 'CONNECTED') {
    if (!userVoiceChannel) {
      await interaction.followUp({
        content: '⚠️ You must join a voice channel first to play music.',
        ephemeral: true,
      });
      return;
    }

    const me = guild?.members.me ?? (await guild?.members.fetchMe().catch(() => null));
    if (me) {
      const perms = userVoiceChannel.permissionsFor(me);
      if (
        !perms ||
        !perms.has([PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak])
      ) {
        await interaction.followUp({
          content: `❌ I do not have permission to Connect or Speak in **${userVoiceChannel.name}**.`,
          ephemeral: true,
        });
        return;
      }
    }

    try {
      await playbackManager.join(guildId, userVoiceChannel.id);
    } catch (err: any) {
      await interaction.followUp({
        content: `❌ Failed to join voice channel: ${err.message}`,
        ephemeral: true,
      });
      return;
    }
  }

  // Resolve audio source
  let source: AudioSource;
  const sourcePath = chosen.sourceUrl;
  const srcManager = audioSourceManager || createConfiguredAudioSourceManager();

  try {
    if (srcManager.canHandle(sourcePath)) {
      const resolved = await srcManager.resolve(sourcePath);
      const mergedMetadata = {
        ...resolved.metadata,
        title: chosen.title || resolved.metadata.title,
        artist: chosen.artist ?? resolved.metadata.artist,
        album: chosen.album ?? resolved.metadata.album,
        duration: chosen.duration ?? resolved.metadata.duration,
      };
      if (
        resolved.isStream ||
        resolved.source.sourceType === 'stream' ||
        resolved.streamUrlOrPath.startsWith('http://') ||
        resolved.streamUrlOrPath.startsWith('https://')
      ) {
        source = new HttpAudioSource(resolved.streamUrlOrPath, mergedMetadata);
      } else {
        source = new LocalAudioSource(resolved.streamUrlOrPath, undefined, probeAudioMetadata);
      }
    } else if (sourcePath.startsWith('http://') || sourcePath.startsWith('https://')) {
      source = new HttpAudioSource(sourcePath, {
        title: chosen.title,
        artist: chosen.artist ?? null,
        album: chosen.album ?? null,
        duration: chosen.duration ?? null,
      });
    } else if (fs.existsSync(sourcePath)) {
      source = new LocalAudioSource(sourcePath, undefined, probeAudioMetadata);
    } else {
      const musicDir = resolveMusicStorageDir();
      const inStorage = path.resolve(musicDir, sourcePath);
      if (fs.existsSync(inStorage)) {
        source = new LocalAudioSource(inStorage, undefined, probeAudioMetadata);
      } else {
        const resolved = await resolveAnyAudioInput(sourcePath, srcManager, context.trackManager);
        source = new LocalAudioSource(resolved.path, undefined, probeAudioMetadata);
      }
    }

    const playResult = await playbackManager.play(
      guildId,
      source,
      {
        name: chosen.title,
        path: chosen.sourceUrl,
        duration: chosen.duration ?? undefined,
        artist: chosen.artist ?? undefined,
        album: chosen.album ?? undefined,
        thumbnailUrl: chosen.thumbnailUrl ?? undefined,
        sourceProvider: chosen.sourceProvider,
        sourceUrl: chosen.sourceUrl,
        addedBy: member?.displayName || interaction.user.username,
        userId: interaction.user.id,
      },
      { playNext: session.isPlayNext },
    );

    const durationStr = formatDuration(chosen.duration);
    const confirmationEmbed = new EmbedBuilder()
      .setTitle(
        session.isPlayNext
          ? '⏩ Added to Play Next'
          : playResult.status === 'started'
            ? '▶️ Now Playing'
            : '➕ Added to Queue',
      )
      .setDescription(`**${chosen.title}**${chosen.artist ? `\n*by ${chosen.artist}*` : ''}`)
      .setColor(session.isPlayNext ? 0x10b981 : playResult.status === 'started' ? 0x10b981 : 0x3b82f6)
      .addFields(
        { name: 'Duration', value: `\`${durationStr}\``, inline: true },
        { name: 'Source', value: chosen.sourceProvider.toUpperCase(), inline: true },
        {
          name: 'Position',
          value: session.isPlayNext
            ? `**#${playResult.position} (Up Next)**`
            : playResult.status === 'started'
              ? '**Now Playing**'
              : `**#${playResult.position}**`,
          inline: true,
        },
      )
      .setFooter({ text: `Requested by ${member?.displayName || interaction.user.username}` });

    if (chosen.thumbnailUrl) {
      confirmationEmbed.setThumbnail(chosen.thumbnailUrl);
    }

    // Edit original message: clear components and update embed
    await interaction.editReply({
      content: playResult.status === 'started'
        ? `▶️ Started: **${chosen.title}**${chosen.artist ? ` by **${chosen.artist}**` : ''} \`[${durationStr}]\``
        : session.isPlayNext
          ? `⏩ Added to play next: **${chosen.title}** \`[${durationStr}]\` (Position: #${playResult.position})`
          : `➕ Added to queue: **${chosen.title}** \`[${durationStr}]\` (Position: #${playResult.position})`,
      embeds: [confirmationEmbed],
      components: [],
    });

    // Remove session
    removeSongChoiceSession(sessionId);

    // Refresh control panel
    await refreshPanel(guildId, playbackManager).catch(() => {});
  } catch (err: any) {
    logger.error({ err, chosen }, '[SONG-CHOICE] Failed to start playback of selected song');
    await interaction.followUp({
      content: `❌ Could not play **${chosen.title}**: ${err.message}`,
      ephemeral: true,
    });
  }
}
