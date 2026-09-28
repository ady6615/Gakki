import {
  SlashCommandBuilder,
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
  type GuildMember,
  PermissionsBitField,
} from 'discord.js';
import type {
  AudioPlayerManager,
  PlaybackManager,
  QueueTrack,
  LoopMode,
  AudioSource,
  AudioSourceManager,
  AnalyticsManager,
  PlaylistManager,
  TrackManager,
  AiRecommendationManager,
  DJProfile,
  LyricsManager,
  FavoritesManager,
} from '@gakki/core';
import {
  LocalAudioSource,
  HttpAudioSource,
  VoicePermissionError,
  createLogger,
} from '@gakki/core';
import { probeAudioMetadata } from '../audio/ffmpeg';
import { listLocalAudioFiles, listLocalFolders } from '../audio/local-files';
import { enqueueFolder, enqueueMultipleFiles } from '../audio/batch-loader';
import { globalRateLimiter } from '../security/rate-limiter';
import { createConfiguredAudioSourceManager } from '../sources';
import { getFFmpegCapabilities } from '../audio/ffmpeg-capabilities';
import { StemWorkerPool } from '../audio/stems/stem-worker-pool';
import { StemProviderRegistry } from '../audio/stems/stem-provider.registry';
import { checkCommandPermission, CommandPermissionLevel } from './permissions';
import { BotErrors, formatUserFacingError } from './errors';

const logger = createLogger('discord-commands');

/**
 * Format duration in seconds to M:SS.
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || isNaN(seconds)) return 'Unknown';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export const slashCommandDefinitions = [

  new SlashCommandBuilder()
    .setName('join')
    .setDescription('Join your current voice channel'),

  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a local audio file, URL, or search query')
    .addStringOption((option) =>
      option
        .setName('input')
        .setDescription('Local file name, HTTP audio URL, or SoundCloud link')
        .setRequired(false)
        .setAutocomplete(true),
    )
    .addStringOption((option) =>
      option
        .setName('file')
        .setDescription('Local file name in storage/music (legacy compatibility)')
        .setRequired(false)
        .setAutocomplete(true),
    ),

  new SlashCommandBuilder()
    .setName('search')
    .setDescription('Search local library and authorized audio sources')
    .addStringOption((option) =>
      option
        .setName('query')
        .setDescription('Search terms (title, artist, keywords)')
        .setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName('history')
    .setDescription('Show recent playback history for this server')
    .addIntegerOption((option) =>
      option
        .setName('limit')
        .setDescription('Number of records to show (default 10, max 25)')
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(25),
    ),

  new SlashCommandBuilder()
    .setName('recent')
    .setDescription('Show compact list of recently played tracks')
    .addIntegerOption((option) =>
      option
        .setName('limit')
        .setDescription('Number of tracks to show (default 5, max 15)')
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(15),
    ),

  new SlashCommandBuilder()
    .setName('playlist')
    .setDescription('Manage and play playlists')
    .addSubcommand((sub) =>
      sub
        .setName('create')
        .setDescription('Create a new playlist')
        .addStringOption((opt) =>
          opt.setName('name').setDescription('Playlist name').setRequired(true),
        )
        .addStringOption((opt) =>
          opt.setName('description').setDescription('Optional description').setRequired(false),
        )
        .addStringOption((opt) =>
          opt
            .setName('visibility')
            .setDescription('Playlist visibility')
            .setRequired(false)
            .addChoices(
              { name: 'Server (shared with this guild)', value: 'guild' },
              { name: 'Private (only you)', value: 'private' },
              { name: 'Public (all guilds)', value: 'public' },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('list').setDescription('List available playlists for you and this server'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('play')
        .setDescription('Enqueue and play an entire playlist')
        .addStringOption((opt) =>
          opt.setName('name').setDescription('Playlist name').setRequired(true).setAutocomplete(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Add a song to a playlist')
        .addStringOption((opt) =>
          opt.setName('name').setDescription('Playlist name').setRequired(true).setAutocomplete(true),
        )
        .addStringOption((opt) =>
          opt.setName('track').setDescription('Track name, URL, or local file').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Remove a track from a playlist by its position number')
        .addStringOption((opt) =>
          opt.setName('name').setDescription('Playlist name').setRequired(true).setAutocomplete(true),
        )
        .addIntegerOption((opt) =>
          opt.setName('index').setDescription('Track position number (1, 2, ...)').setRequired(true).setMinValue(1),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('rename')
        .setDescription('Rename an existing playlist')
        .addStringOption((opt) =>
          opt.setName('name').setDescription('Current playlist name').setRequired(true).setAutocomplete(true),
        )
        .addStringOption((opt) =>
          opt.setName('new_name').setDescription('New playlist name').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('reorder')
        .setDescription('Reorder a track within a playlist')
        .addStringOption((opt) =>
          opt.setName('name').setDescription('Playlist name').setRequired(true).setAutocomplete(true),
        )
        .addIntegerOption((opt) =>
          opt.setName('from').setDescription('Current track position (1-based)').setRequired(true).setMinValue(1),
        )
        .addIntegerOption((opt) =>
          opt.setName('to').setDescription('Target track position (1-based)').setRequired(true).setMinValue(1),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('duplicate')
        .setDescription('Duplicate an existing playlist')
        .addStringOption((opt) =>
          opt.setName('name').setDescription('Source playlist name').setRequired(true).setAutocomplete(true),
        )
        .addStringOption((opt) =>
          opt.setName('new_name').setDescription('New playlist name').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('delete')
        .setDescription('Delete a playlist')
        .addStringOption((opt) =>
          opt.setName('name').setDescription('Playlist name to delete').setRequired(true).setAutocomplete(true),
        ),
    ),

  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Display the current playback queue'),

  new SlashCommandBuilder()
    .setName('addqueue')
    .setDescription('Add multiple files or an entire folder to the queue')
    .addStringOption((option) =>
      option
        .setName('file')
        .setDescription('Single audio file to add')
        .setRequired(false)
        .setAutocomplete(true),
    )
    .addStringOption((option) =>
      option
        .setName('files')
        .setDescription('Multiple audio files (e.g. "01.mp3, 02.mp3")')
        .setRequired(false),
    )
    .addStringOption((option) =>
      option
        .setName('folder')
        .setDescription('Folder name in storage/music (e.g. my-playlist)')
        .setRequired(false)
        .setAutocomplete(true),
    ),

  new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Pause the current track'),

  new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Resume the paused track'),

  new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Skip the current track and play the next in queue'),

  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Stop playback and leave the voice channel'),

  new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Show information about the currently playing track'),

  new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Set playback volume (0 to 200%)')
    .addIntegerOption((option) =>
      option
        .setName('level')
        .setDescription('Volume level from 0 to 200 (100 is normal)')
        .setRequired(true)
        .setMinValue(0)
        .setMaxValue(200),
    ),

  new SlashCommandBuilder()
    .setName('bassboost')
    .setDescription('Toggle audio bass boost filter')
    .addStringOption((option) =>
      option
        .setName('mode')
        .setDescription('Turn bass boost on or off')
        .setRequired(true)
        .addChoices(
          { name: 'On', value: 'on' },
          { name: 'Off', value: 'off' },
        ),
    ),

  new SlashCommandBuilder()
    .setName('speed')
    .setDescription('Set playback speed multiplier (0.5x to 2.0x)')
    .addNumberOption((option) =>
      option
        .setName('value')
        .setDescription('Speed multiplier between 0.5 and 2.0')
        .setRequired(true)
        .setMinValue(0.5)
        .setMaxValue(2.0),
    ),

  new SlashCommandBuilder()
    .setName('nightcore')
    .setDescription('Toggle nightcore audio effect (pitch shift and speed up)')
    .addStringOption((option) =>
      option
        .setName('mode')
        .setDescription('Turn nightcore mode on or off')
        .setRequired(true)
        .addChoices(
          { name: 'On', value: 'on' },
          { name: 'Off', value: 'off' },
        ),
    ),

  new SlashCommandBuilder()
    .setName('shuffle')
    .setDescription('Shuffle all tracks currently in the queue'),

  new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove a track from the queue by its position number')
    .addIntegerOption((option) =>
      option
        .setName('index')
        .setDescription('Track position in queue (1, 2, ...)')
        .setRequired(true)
        .setMinValue(1),
    ),

  new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Clear all queued tracks without stopping the current track'),

  new SlashCommandBuilder()
    .setName('move')
    .setDescription('Move a queued track from one position to another')
    .addIntegerOption((option) =>
      option
        .setName('from')
        .setDescription('Current track position in queue')
        .setRequired(true)
        .setMinValue(1),
    )
    .addIntegerOption((option) =>
      option
        .setName('to')
        .setDescription('Target position in queue')
        .setRequired(true)
        .setMinValue(1),
    ),

  new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Set queue / track repetition mode')
    .addStringOption((option) =>
      option
        .setName('mode')
        .setDescription('Repeat mode')
        .setRequired(true)
        .addChoices(
          { name: 'Off', value: 'off' },
          { name: 'Track (repeat current song)', value: 'track' },
          { name: 'Queue (repeat entire queue)', value: 'queue' },
        ),
    ),

  new SlashCommandBuilder()
    .setName('stay')
    .setDescription('Set whether bot stays in voice channel indefinitely')
    .addStringOption((option) =>
      option
        .setName('mode')
        .setDescription('Turn stay-in-channel mode on or off')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('vibe')
    .setDescription('Generate a Same Vibe recommendation playlist based on audio similarity')
    .addStringOption((option) =>
      option
        .setName('track')
        .setDescription('Track title or query to match (uses current track if omitted)')
        .setRequired(false),
    )
    .addStringOption((option) =>
      option
        .setName('profile')
        .setDescription('Acoustic vibe profile')
        .setRequired(false)
        .addChoices(
          { name: 'Balanced (Default)', value: 'BALANCED' },
          { name: 'Chill (Smooth & mellow)', value: 'CHILL' },
          { name: 'Energetic (Upbeat & driving)', value: 'ENERGETIC' },
        ),
    ),

  new SlashCommandBuilder()
    .setName('smartshuffle')
    .setDescription('Intelligently shuffle queue based on audio similarity and energy flow')
    .addStringOption((option) =>
      option
        .setName('profile')
        .setDescription('Acoustic energy profile')
        .setRequired(false)
        .addChoices(
          { name: 'Balanced', value: 'BALANCED' },
          { name: 'Chill', value: 'CHILL' },
          { name: 'Energetic', value: 'ENERGETIC' },
        ),
    ),

  new SlashCommandBuilder()
    .setName('dj')
    .setDescription('Manage Dynamic AI DJ mode')
    .addSubcommand((sub) =>
      sub
        .setName('on')
        .setDescription('Enable dynamic DJ mode')
        .addStringOption((opt) =>
          opt
            .setName('profile')
            .setDescription('DJ energy profile')
            .setRequired(false)
            .addChoices(
              { name: 'Balanced (Default)', value: 'BALANCED' },
              { name: 'Chill (Low energy transitions)', value: 'CHILL' },
              { name: 'Energetic (High energy transitions)', value: 'ENERGETIC' },
            ),
        ),
    )
    .addSubcommand((sub) => sub.setName('off').setDescription('Disable dynamic DJ mode'))
    .addSubcommand((sub) =>
      sub.setName('status').setDescription('View current dynamic DJ status and lookahead queue'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('profile')
        .setDescription('Change DJ energy profile')
        .addStringOption((opt) =>
          opt
            .setName('name')
            .setDescription('DJ energy profile')
            .setRequired(true)
            .addChoices(
              { name: 'Balanced', value: 'BALANCED' },
              { name: 'Chill', value: 'CHILL' },
              { name: 'Energetic', value: 'ENERGETIC' },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('stems')
        .setDescription('Enable or disable stem separation for layered DJ mixing')
        .addStringOption((opt) =>
          opt
            .setName('state')
            .setDescription('Turn stem separation on or off')
            .setRequired(true)
            .addChoices({ name: 'On', value: 'on' }, { name: 'Off', value: 'off' }),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('vocalduck')
        .setDescription('Enable or disable vocal clash prevention ducking')
        .addStringOption((opt) =>
          opt
            .setName('state')
            .setDescription('Turn vocal ducking on or off')
            .setRequired(true)
            .addChoices({ name: 'On', value: 'on' }, { name: 'Off', value: 'off' }),
        ),
    ),

  new SlashCommandBuilder()
    .setName('stems')
    .setDescription('Stem separation status and analysis commands')
    .addSubcommand((sub) =>
      sub
        .setName('status')
        .setDescription('View stem separation status for a track or general capabilities')
        .addStringOption((opt) =>
          opt
            .setName('track')
            .setDescription('Track title, query, or UUID')
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('analyze')
        .setDescription('Enqueue background stem separation for a track')
        .addStringOption((opt) =>
          opt
            .setName('track')
            .setDescription('Track title, query, or UUID')
            .setRequired(true),
        ),
    ),

  new SlashCommandBuilder()
    .setName('transition')
    .setDescription('Configure seamless audio mixing, crossfading & DJ transitions')
    .addSubcommand((sub) =>
      sub
        .setName('on')
        .setDescription('Enable seamless transitions / crossfading'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('off')
        .setDescription('Disable seamless transitions (use hard cuts)'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('duration')
        .setDescription('Set transition crossfade duration (1-8 seconds)')
        .addIntegerOption((opt) =>
          opt
            .setName('seconds')
            .setDescription('Duration in seconds (1 to 8)')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(8),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('profile')
        .setDescription('Select transition profile')
        .addStringOption((opt) =>
          opt
            .setName('name')
            .setDescription('Transition profile')
            .setRequired(true)
            .addChoices(
              { name: 'Smooth (6-8s, equal-power, harmonic matching)', value: 'SMOOTH' },
              { name: 'Balanced (4-6s, equal-power, dynamic)', value: 'BALANCED' },
              { name: 'Energetic (1-4s, punchy drop mixing)', value: 'ENERGETIC' },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('status')
        .setDescription('View current transition settings and upcoming transition preview'),
    ),

  new SlashCommandBuilder()
    .setName('lyrics')
    .setDescription('Display plain or synchronized lyrics for current or specified track')
    .addStringOption((option) =>
      option
        .setName('track')
        .setDescription('Track title / artist to look up (uses current track if omitted)')
        .setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName('favorite')
    .setDescription('Save the current or specified track to your personal favorites')
    .addStringOption((option) =>
      option
        .setName('track')
        .setDescription('Track name or search query (uses currently playing track if omitted)')
        .setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName('unfavorite')
    .setDescription('Remove a track from your personal favorites')
    .addStringOption((option) =>
      option
        .setName('track')
        .setDescription('Track name or search query (uses currently playing track if omitted)')
        .setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName('favorites')
    .setDescription('View your personal favorite tracks')
    .addIntegerOption((option) =>
      option
        .setName('page')
        .setDescription('Page number')
        .setRequired(false)
        .setMinValue(1),
    ),

  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show organized command guide and platform instructions')
    .addStringOption((option) =>
      option
        .setName('category')
        .setDescription('Filter by category')
        .setRequired(false)
        .addChoices(
          { name: '🎵 Playback', value: 'playback' },
          { name: '📑 Playlists', value: 'playlists' },
          { name: '🎛️ DJ & Transitions', value: 'dj' },
          { name: '📚 Library & Lyrics', value: 'library' },
          { name: '⚙️ Settings', value: 'settings' },
        ),
    ),
];

/**
 * Handle slash command autocompletion for /play, /addqueue, and /playlist options.
 */
export async function handleAutocomplete(
  interaction: AutocompleteInteraction,
  playlistManager?: PlaylistManager,
): Promise<void> {
  const focusedOption = interaction.options.getFocused(true);

  if (focusedOption.name === 'file') {
    const files = await listLocalAudioFiles();
    const query = (focusedOption.value || '').toLowerCase();
    const filtered = files
      .filter((file) => file.toLowerCase().includes(query))
      .slice(0, 25);

    await interaction.respond(
      filtered.map((file) => ({ name: file, value: file })),
    );
  } else if (focusedOption.name === 'folder') {
    const folders = await listLocalFolders();
    const query = (focusedOption.value || '').toLowerCase();
    const filtered = folders
      .filter((folder) => folder.toLowerCase().includes(query))
      .slice(0, 25);

    await interaction.respond(
      filtered.map((folder) => ({ name: folder, value: folder })),
    );
  } else if (focusedOption.name === 'name' && playlistManager) {
    const member = interaction.member as GuildMember;
    const guildId = interaction.guildId || undefined;
    const userId = member?.user?.id || member?.id;
    const query = (focusedOption.value || '').toLowerCase();

    try {
      const { userPlaylists, guildPlaylists } = await playlistManager.listPlaylists({ guildId, userId });
      const combined = [...userPlaylists, ...guildPlaylists];
      const seen = new Set<string>();
      const unique = combined.filter((p) => {
        if (seen.has(p.id)) return false;
        seen.add(p.id);
        return true;
      });

      const filtered = unique
        .filter((p) => p.name.toLowerCase().includes(query))
        .slice(0, 25);

      await interaction.respond(
        filtered.map((p) => ({ name: p.name, value: p.name })),
      );
    } catch {
      await interaction.respond([]);
    }
  }
}

/**
 * Handle incoming chat input slash commands.
 */
export async function handleChatInputCommand(
  interaction: ChatInputCommandInteraction,
  manager: PlaybackManager | AudioPlayerManager,
  audioSourceManager?: AudioSourceManager,
  analyticsManager?: AnalyticsManager,
  playlistManager?: PlaylistManager,
  trackManager?: TrackManager,
  recManager?: AiRecommendationManager,
  lyricsManager?: LyricsManager,
  favoritesManager?: FavoritesManager,
): Promise<void> {
  const playbackManager: PlaybackManager =
    'playbackManager' in manager
      ? (manager as AudioPlayerManager).playbackManager
      : (manager as PlaybackManager);

  const { commandName, guildId } = interaction;

  if (!guildId) {
    await interaction.reply({
      content: 'Commands must be executed within a Discord server.',
      ephemeral: true,
    });
    return;
  }

  const member = interaction.member as GuildMember;
  const userVoiceChannel = member?.voice?.channel;

  switch (commandName) {
    case 'join': {
      if (!userVoiceChannel) {
        await interaction.reply({
          content: 'You must be in a voice channel to use this command.',
          ephemeral: true,
        });
        return;
      }

      // Check bot permissions
      const me = interaction.guild?.members.me;
      if (me) {
        const perms = userVoiceChannel.permissionsFor(me);
        if (
          !perms ||
          !perms.has([PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak])
        ) {
          await interaction.reply({
            content: `I do not have permission to Connect or Speak in **${userVoiceChannel.name}**.`,
            ephemeral: true,
          });
          return;
        }
      }

      await interaction.deferReply();
      try {
        await playbackManager.join(guildId, userVoiceChannel.id);
        await interaction.editReply(`Joined voice channel **${userVoiceChannel.name}**.`);
      } catch (error) {
        logger.error({ err: error, guildId }, '[ERROR] Failed to join voice channel');
        if (error instanceof VoicePermissionError) {
          await interaction.editReply(`Missing permissions: ${error.missingPermissions.join(', ')}.`);
        } else {
          await interaction.editReply(`Failed to join voice channel: ${(error as Error).message}`);
        }
      }
      break;
    }

    case 'play': {
      await interaction.deferReply();

      // Rate limiting
      const userId = member?.user?.id || member?.id || 'anonymous';
      const userLimit = globalRateLimiter.check(`user:${userId}`);
      if (!userLimit.allowed) {
        await interaction.editReply(`⚠️ Rate limit exceeded. Please wait ${Math.ceil(userLimit.retryAfterMs / 1000)}s.`);
        return;
      }
      const guildLimit = globalRateLimiter.check(`guild:${guildId}`);
      if (!guildLimit.allowed) {
        await interaction.editReply(`⚠️ Guild rate limit exceeded. Please wait ${Math.ceil(guildLimit.retryAfterMs / 1000)}s.`);
        return;
      }

      // Check if bot is connected, or join user voice channel
      const currentState = playbackManager.getState(guildId);
      if (currentState.voiceState !== 'CONNECTED') {
        if (!userVoiceChannel) {
          await interaction.editReply('You must be in a voice channel to play music.');
          return;
        }

        const me = interaction.guild?.members.me;
        if (me) {
          const perms = userVoiceChannel.permissionsFor(me);
          if (
            !perms ||
            !perms.has([PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak])
          ) {
            await interaction.editReply(
              `I do not have permission to Connect or Speak in **${userVoiceChannel.name}**.`,
            );
            return;
          }
        }

        try {
          await playbackManager.join(guildId, userVoiceChannel.id);
        } catch (error) {
          logger.error({ err: error, guildId }, '[ERROR] Failed to join voice before play');
          await interaction.editReply(`Failed to join voice channel: ${(error as Error).message}`);
          return;
        }
      }

      // Determine input to play
      let input = interaction.options.getString('input') || interaction.options.getString('file');
      if (!input || input.trim() === '') {
        const available = await listLocalAudioFiles();
        if (available.length === 0) {
          await interaction.editReply('No local audio files found in storage/music directory.');
          return;
        }
        input = available[0];
      }
      input = input.trim();

      const srcManager = audioSourceManager || createConfiguredAudioSourceManager();

      let source: AudioSource;
      let trackTitle: string;
      let trackDuration: number | null | undefined;
      let trackArtist: string | null | undefined;
      let trackAlbum: string | null | undefined;
      let trackThumb: string | null | undefined;
      let sourceProviderName = 'Local Library';
      let trackPath = input;

      if (srcManager.canHandle(input)) {
        try {
          const resolved = await srcManager.resolve(input);
          trackTitle = resolved.title;
          trackDuration = resolved.metadata.duration ?? undefined;
          trackArtist = resolved.metadata.artist ?? undefined;
          trackAlbum = resolved.metadata.album ?? undefined;
          trackThumb = resolved.metadata.thumbnailUrl ?? resolved.metadata.coverArtPath ?? undefined;
          sourceProviderName =
            resolved.source.provider === 'local'
              ? 'Local Library'
              : resolved.source.provider === 'http_stream'
                ? 'HTTP Stream'
                : resolved.source.provider.charAt(0).toUpperCase() + resolved.source.provider.slice(1);
          trackPath = resolved.streamUrlOrPath;

          if (
            resolved.isStream ||
            resolved.source.sourceType === 'stream' ||
            resolved.streamUrlOrPath.startsWith('http://') ||
            resolved.streamUrlOrPath.startsWith('https://')
          ) {
            source = new HttpAudioSource(resolved.streamUrlOrPath, resolved.metadata);
          } else {
            source = new LocalAudioSource(resolved.streamUrlOrPath, undefined, probeAudioMetadata);
          }
        } catch (err: any) {
          logger.warn({ err, input }, '[AUDIO] Source resolution failed');
          await interaction.editReply(err.message || `Failed to resolve source for: ${input}`);
          return;
        }
      } else {
        source = new LocalAudioSource(input, undefined, probeAudioMetadata);
        try {
          await source.validate();
          const meta = await source.getMetadata();
          trackTitle = meta.title;
          trackDuration = meta.duration ?? undefined;
          trackArtist = meta.artist ?? undefined;
          trackAlbum = meta.album ?? undefined;
        } catch (err: any) {
          logger.warn({ err, file: input }, '[AUDIO] File validation failed');
          await interaction.editReply(err.message || `File error for: ${input}`);
          return;
        }
      }

      try {
        const durationStr = formatDuration(trackDuration);
        const playResult = await playbackManager.play(guildId, source, {
          name: trackTitle,
          path: trackPath,
          duration: trackDuration ?? undefined,
          artist: trackArtist,
          album: trackAlbum,
          thumbnailUrl: trackThumb,
          sourceProvider: sourceProviderName,
          sourceUrl: input,
          addedBy: member.displayName || member.user?.username,
          userId: member.user?.id || member.id,
        });

        if (playResult.status === 'started') {
          const embed = new EmbedBuilder()
            .setTitle('▶️ Started Playback')
            .setDescription(`**${trackTitle}**${trackArtist ? `\n*${trackArtist}*` : ''}`)
            .setColor(0x10b981)
            .addFields(
              { name: 'Duration', value: `\`${durationStr}\``, inline: true },
              { name: 'Source', value: sourceProviderName, inline: true },
            );
          if (trackAlbum) {
            embed.addFields({ name: 'Album', value: trackAlbum, inline: true });
          }
          if (trackThumb && trackThumb.startsWith('http')) {
            embed.setThumbnail(trackThumb);
          }

          await interaction.editReply({
            content: `▶️ Started: **${trackTitle}**${trackArtist ? ` by **${trackArtist}**` : ''} \`[${durationStr}]\``,
            embeds: [embed],
          });
        } else {
          const embed = new EmbedBuilder()
            .setTitle('➕ Added to Queue')
            .setDescription(`**${trackTitle}**${trackArtist ? `\n*${trackArtist}*` : ''}`)
            .setColor(0x3b82f6)
            .addFields(
              { name: 'Position', value: `**#${playResult.position}**`, inline: true },
              { name: 'Duration', value: `\`${durationStr}\``, inline: true },
              { name: 'Source', value: sourceProviderName, inline: true },
            );
          if (trackThumb && trackThumb.startsWith('http')) {
            embed.setThumbnail(trackThumb);
          }

          await interaction.editReply({
            content: `➕ Added to queue: **${trackTitle}**${trackArtist ? ` by **${trackArtist}**` : ''}\nPosition: **${playResult.position}**`,
            embeds: [embed],
          });
        }
      } catch (error) {
        logger.error({ err: error, guildId }, '[ERROR] Playback failed');
        await interaction.editReply(`Playback failed: ${(error as Error).message}`);
      }
      break;
    }

    case 'search': {
      await interaction.deferReply();
      const query = interaction.options.getString('query', true);

      const userId = member?.user?.id || member?.id || 'anonymous';
      const userLimit = globalRateLimiter.check(`user:${userId}`);
      if (!userLimit.allowed) {
        await interaction.editReply(`⚠️ Rate limit exceeded. Please wait ${Math.ceil(userLimit.retryAfterMs / 1000)}s.`);
        return;
      }

      try {
        const srcManager = audioSourceManager || createConfiguredAudioSourceManager();
        const results = await srcManager.search(query, { limit: 5 });

        if (results.length === 0) {
          await interaction.editReply(`No search results found for: "${query}"`);
          return;
        }

        const embed = new EmbedBuilder()
          .setTitle(`🔎 Search Results for "${query}"`)
          .setColor(0x7c3aed);

        let description = '';
        results.forEach((r, idx) => {
          const dur = r.duration ? ` \`[${formatDuration(r.duration)}]\`` : '';
          const artist = r.artist ? ` — *${r.artist}*` : '';
          description += `**${idx + 1}.** ${r.title}${artist}${dur} *(Source: ${r.provider})*\n`;
        });
        description += `\n*To play a track, type \`/play <sourceUrl or title>\`*`;
        embed.setDescription(description);

        await interaction.editReply({
          content: `Found ${results.length} result(s) for "${query}".`,
          embeds: [embed],
        });
      } catch (err: any) {
        logger.error({ err, query }, '[ERROR] Search failed');
        await interaction.editReply(`Search error: ${err.message}`);
      }
      break;
    }

    case 'queue': {
      const currentTrack = playbackManager.getCurrentTrack(guildId);
      const queueItems = playbackManager.queueManager.getDisplayQueue(guildId);

      if (!currentTrack && queueItems.length === 0) {
        await interaction.reply('The queue is empty.');
        return;
      }

      let response = '';
      if (currentTrack) {
        const dur = formatDuration(currentTrack.duration);
        response += `🎵 **Now Playing**\n${currentTrack.name} \`[${dur}]\`\n\n`;
      } else {
        response += `🎵 **Now Playing**\n*Nothing currently playing*\n\n`;
      }

      if (queueItems.length > 0) {
        response += `**Queue:**\n`;
        const preview = queueItems.slice(0, 10);
        for (const item of preview) {
          const itemDur = item.duration ? ` \`[${formatDuration(item.duration)}]\`` : '';
          response += `${item.position}. ${item.name}${itemDur}\n`;
        }

        if (queueItems.length > 10) {
          response += `*...and ${queueItems.length - 10} more*\n`;
        }
        response += `\n*${queueItems.length} track${queueItems.length === 1 ? '' : 's'} queued*`;
      } else {
        response += `The queue is empty.`;
      }

      await interaction.reply({ content: response });
      break;
    }

    case 'addqueue': {
      await interaction.deferReply();
      const folder = interaction.options.getString('folder');
      const file = interaction.options.getString('file');
      const filesInput = interaction.options.getString('files');

      let addedTracks: QueueTrack[] = [];
      const userTag = member.displayName || member.user?.username;

      try {
        if (folder) {
          addedTracks = await enqueueFolder(guildId, folder, playbackManager.queueManager, userTag);
        } else if (filesInput) {
          const rawList = filesInput.includes(',') ? filesInput.split(',') : filesInput.split(/\s+/);
          addedTracks = await enqueueMultipleFiles(guildId, rawList, playbackManager.queueManager, userTag);
        } else if (file) {
          addedTracks = await enqueueMultipleFiles(guildId, [file], playbackManager.queueManager, userTag);
        } else {
          await interaction.editReply('Please specify a `file`, `files`, or `folder` to add to the queue.');
          return;
        }

        await interaction.editReply(`➕ Added **${addedTracks.length}** track(s) to the queue.`);
      } catch (err: any) {
        logger.error({ err, guildId }, '[ERROR] Failed to add tracks to queue');
        await interaction.editReply(`Failed to add tracks: ${err.message}`);
      }
      break;
    }

    case 'pause': {
      const state = playbackManager.getState(guildId);
      if (state.playerState !== 'PLAYING') {
        await interaction.reply({
          content: 'No audio is currently playing.',
          ephemeral: true,
        });
        return;
      }

      const paused = playbackManager.pause(guildId);
      if (paused) {
        await interaction.reply('Playback paused.');
      } else {
        await interaction.reply({
          content: 'Could not pause playback.',
          ephemeral: true,
        });
      }
      break;
    }

    case 'resume': {
      const state = playbackManager.getState(guildId);
      if (state.playerState !== 'PAUSED') {
        await interaction.reply({
          content: 'Audio is not currently paused.',
          ephemeral: true,
        });
        return;
      }

      const resumed = playbackManager.resume(guildId);
      if (resumed) {
        await interaction.reply('Playback resumed.');
      } else {
        await interaction.reply({
          content: 'Could not resume playback.',
          ephemeral: true,
        });
      }
      break;
    }

    case 'skip': {
      const skipResult = await playbackManager.skip(guildId);
      if (!skipResult.skipped) {
        await interaction.reply({
          content: 'No audio is currently playing to skip.',
          ephemeral: true,
        });
        return;
      }

      if (skipResult.nowPlaying) {
        const dur = formatDuration(skipResult.nowPlaying.duration);
        await interaction.reply(
          `⏭️ Skipped track. Now playing: **${skipResult.nowPlaying.name}** \`[${dur}]\``,
        );
      } else {
        await interaction.reply('⏭️ Skipped track. The queue is now empty.');
      }
      break;
    }

    case 'leave': {
      const state = playbackManager.getState(guildId);
      if (state.voiceState === 'DISCONNECTED') {
        await interaction.reply({
          content: 'Not currently connected to any voice channel.',
          ephemeral: true,
        });
        return;
      }

      await playbackManager.leave(guildId);
      await interaction.reply('Disconnected from voice channel.');
      break;
    }

    case 'nowplaying': {
      const currentTrack = playbackManager.getCurrentTrack(guildId);
      const state = playbackManager.getState(guildId);

      if (!currentTrack || state.playerState === 'IDLE') {
        await interaction.reply('Nothing is currently playing.');
        return;
      }

      const durationStr = formatDuration(currentTrack.duration);
      const queueEvent = playbackManager.getQueueEvent(guildId);
      const queueTrack = queueEvent.currentTrack;

      const embed = new EmbedBuilder()
        .setTitle('🎵 NOW PLAYING')
        .setDescription(`**${currentTrack.name}**${currentTrack.artist ? `\n*${currentTrack.artist}*` : ''}`)
        .setColor(0x7c3aed)
        .addFields(
          { name: 'Duration', value: `\`${durationStr}\``, inline: true },
          { name: 'Status', value: state.playerState, inline: true },
        );

      if (queueTrack?.album) {
        embed.addFields({ name: 'Album', value: queueTrack.album, inline: true });
      }
      if (queueTrack?.sourceProvider) {
        embed.addFields({ name: 'Source', value: queueTrack.sourceProvider, inline: true });
      }
      if (queueTrack?.thumbnailUrl && queueTrack.thumbnailUrl.startsWith('http')) {
        embed.setThumbnail(queueTrack.thumbnailUrl);
      }

      await interaction.reply({
        content: `**Now Playing:** ${currentTrack.name}${currentTrack.artist ? ` — *${currentTrack.artist}*` : ''}\n**Status:** ${state.playerState}\n**Duration:** \`${durationStr}\``,
        embeds: [embed],
      });
      break;
    }

    case 'volume': {
      const level = interaction.options.getInteger('level');
      if (level === null || level < 0 || level > 200) {
        await interaction.reply({
          content: 'Volume must be an integer between 0 and 200.',
          ephemeral: true,
        });
        return;
      }

      const updatedVolume = playbackManager.setVolume(guildId, level);
      await interaction.reply(`🔊 Volume set to **${updatedVolume}%**`);
      break;
    }

    case 'bassboost': {
      const mode = interaction.options.getString('mode', true);
      const enabled = mode === 'on';

      await interaction.deferReply();
      try {
        await playbackManager.setBassboost(guildId, enabled);
        await interaction.editReply(`🎚️ Bassboost turned **${enabled ? 'ON' : 'OFF'}**`);
      } catch (err: any) {
        await interaction.editReply(`Failed to update bassboost: ${err.message}`);
      }
      break;
    }

    case 'speed': {
      const value = interaction.options.getNumber('value', true);
      if (value < 0.5 || value > 2.0) {
        await interaction.reply({
          content: 'Speed must be between 0.5 and 2.0.',
          ephemeral: true,
        });
        return;
      }

      await interaction.deferReply();
      try {
        const updated = await playbackManager.setSpeed(guildId, value);
        await interaction.editReply(`⏩ Playback speed set to **${updated.speed}x**`);
      } catch (err: any) {
        await interaction.editReply(`Failed to update speed: ${err.message}`);
      }
      break;
    }

    case 'nightcore': {
      const mode = interaction.options.getString('mode', true);
      const enabled = mode === 'on';

      await interaction.deferReply();
      try {
        await playbackManager.setNightcore(guildId, enabled);
        await interaction.editReply(`✨ Nightcore mode turned **${enabled ? 'ON' : 'OFF'}**`);
      } catch (err: any) {
        await interaction.editReply(`Failed to update nightcore: ${err.message}`);
      }
      break;
    }

    case 'shuffle': {
      const count = playbackManager.queueManager.getQueueLength(guildId);
      if (count <= 1) {
        await interaction.reply({
          content: 'Not enough tracks in the queue to shuffle.',
          ephemeral: true,
        });
        return;
      }

      const shuffled = playbackManager.shuffleQueue(guildId);
      if (shuffled) {
        await interaction.reply(`🔀 Shuffled **${count}** tracks in the queue.`);
      } else {
        await interaction.reply({
          content: 'Could not shuffle the queue.',
          ephemeral: true,
        });
      }
      break;
    }

    case 'remove': {
      const index = interaction.options.getInteger('index', true);
      const length = playbackManager.queueManager.getQueueLength(guildId);

      if (index < 1 || index > length) {
        await interaction.reply({
          content: `Invalid track position. Please choose a number between 1 and ${length}.`,
          ephemeral: true,
        });
        return;
      }

      const removed = playbackManager.removeQueueTrack(guildId, index);
      if (removed) {
        await interaction.reply(`🗑️ Removed track #${index}: **${removed.name}** from the queue.`);
      } else {
        await interaction.reply({
          content: `Failed to remove track at position ${index}.`,
          ephemeral: true,
        });
      }
      break;
    }

    case 'clear': {
      const length = playbackManager.queueManager.getQueueLength(guildId);
      playbackManager.clearQueue(guildId);
      await interaction.reply(`🧹 Cleared **${length}** track${length === 1 ? '' : 's'} from the queue.`);
      break;
    }

    case 'move': {
      const from = interaction.options.getInteger('from', true);
      const to = interaction.options.getInteger('to', true);
      const length = playbackManager.queueManager.getQueueLength(guildId);

      if (from < 1 || from > length || to < 1 || to > length) {
        await interaction.reply({
          content: `Positions must be between 1 and ${length}.`,
          ephemeral: true,
        });
        return;
      }

      if (from === to) {
        await interaction.reply({
          content: 'Track is already at that position.',
          ephemeral: true,
        });
        return;
      }

      const moved = playbackManager.moveQueueTrack(guildId, from, to);
      if (moved) {
        await interaction.reply(`↔️ Moved **${moved.name}** from position ${from} to ${to}.`);
      } else {
        await interaction.reply({
          content: 'Could not move track.',
          ephemeral: true,
        });
      }
      break;
    }

    case 'loop': {
      const mode = interaction.options.getString('mode', true) as LoopMode;
      playbackManager.setLoopMode(guildId, mode);

      const labels: Record<LoopMode, string> = {
        off: 'Off',
        track: 'Track (repeat current song)',
        queue: 'Queue (repeat entire queue)',
      };
      await interaction.reply(`🔁 Loop mode set to **${labels[mode]}**`);
      break;
    }

    case 'stay': {
      const mode = interaction.options.getString('mode', true);
      const stay = mode === 'on';
      playbackManager.setStayInChannel(guildId, stay);
      await interaction.reply(`🛡️ Stay-in-channel mode turned **${stay ? 'ON' : 'OFF'}**`);
      break;
    }

    case 'history': {
      await interaction.deferReply();
      if (!analyticsManager) {
        await interaction.editReply('History service is currently unavailable.');
        return;
      }

      const limit = interaction.options.getInteger('limit') || 10;
      const { events } = await analyticsManager.getGuildHistory(guildId, { limit });

      if (events.length === 0) {
        await interaction.editReply('No playback history found for this server.');
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle('🎵 PLAY HISTORY')
        .setColor(0x6366f1)
        .setDescription(
          events
            .map((e, idx) => {
              const dateStr = new Date(e.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
              const listenedStr = formatDuration(e.durationListened);
              const statusStr = e.completed ? 'Finished' : e.endReason === 'skipped' ? `Skipped at ${listenedStr}` : (e.endReason || 'Stopped');
              return `${idx + 1}. **${e.track.title}**${e.track.artist ? ` — *${e.track.artist}*` : ''}\n   *${dateStr}* • Played \`${listenedStr}\` • ${statusStr}`;
            })
            .join('\n\n'),
        )
        .setFooter({ text: `Showing recent ${events.length} tracks` });

      await interaction.editReply({ embeds: [embed] });
      break;
    }

    case 'recent': {
      await interaction.deferReply();
      if (!analyticsManager) {
        await interaction.editReply('History service is currently unavailable.');
        return;
      }

      const limit = interaction.options.getInteger('limit') || 5;
      const recent = await analyticsManager.getRecentTracks(guildId, limit);

      if (recent.length === 0) {
        await interaction.editReply('No recently played tracks found.');
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle('🕒 Recently Played')
        .setColor(0x3b82f6)
        .setDescription(
          recent
            .map((r, idx) => {
              const timeStr = new Date(r.lastPlayedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
              return `${idx + 1}. **${r.title}**${r.artist ? ` — *${r.artist}*` : ''} • *${timeStr}*`;
            })
            .join('\n'),
        );

      await interaction.editReply({ embeds: [embed] });
      break;
    }

    case 'playlist': {
      if (!playlistManager) {
        await interaction.reply({ content: 'Playlist service is currently unavailable.', ephemeral: true });
        return;
      }

      const subcommand = interaction.options.getSubcommand();
      const userId = member.user?.id || member.id;

      switch (subcommand) {
        case 'create': {
          const name = interaction.options.getString('name', true);
          const description = interaction.options.getString('description') || undefined;
          const visibility = (interaction.options.getString('visibility') as any) || 'guild';

          try {
            const playlist = await playlistManager.createPlaylist({
              name,
              description,
              ownerUserId: userId,
              guildId,
              visibility,
            });
            await interaction.reply(`✅ Created playlist **${playlist.name}** (${playlist.visibility})`);
          } catch (err: any) {
            await interaction.reply({ content: `Failed to create playlist: ${err.message}`, ephemeral: true });
          }
          break;
        }

        case 'list': {
          await interaction.deferReply();
          try {
            const { userPlaylists, guildPlaylists } = await playlistManager.listPlaylists({ guildId, userId });

            if (userPlaylists.length === 0 && guildPlaylists.length === 0) {
              await interaction.editReply('No playlists found. Create one with `/playlist create <name>`!');
              return;
            }

            const embed = new EmbedBuilder()
              .setTitle('📂 PLAYLISTS')
              .setColor(0x8b5cf6);

            if (userPlaylists.length > 0) {
              embed.addFields({
                name: '👤 My Playlists',
                value: userPlaylists.map((p) => `• **${p.name}** (${p.trackCount} tracks)`).join('\n'),
              });
            }

            if (guildPlaylists.length > 0) {
              embed.addFields({
                name: '🌐 Server Playlists',
                value: guildPlaylists.map((p) => `• **${p.name}** (${p.trackCount} tracks)`).join('\n'),
              });
            }

            await interaction.editReply({ embeds: [embed] });
          } catch (err: any) {
            await interaction.editReply(`Failed to list playlists: ${err.message}`);
          }
          break;
        }

        case 'play': {
          await interaction.deferReply();
          const name = interaction.options.getString('name', true);
          const playlist = await playlistManager.findPlaylistByName(name, { guildId, userId });

          if (!playlist) {
            await interaction.editReply(`Playlist **${name}** not found or you do not have permission to view it.`);
            return;
          }

          if (!userVoiceChannel) {
            await interaction.editReply('You must be in a voice channel to play a playlist.');
            return;
          }

          // Ensure bot joins voice channel
          try {
            await playbackManager.join(guildId, userVoiceChannel.id, {
              guild: interaction.guild,
              channelId: userVoiceChannel.id,
              adapterCreator: interaction.guild?.voiceAdapterCreator,
            });
          } catch (err: any) {
            logger.warn({ err }, 'Could not join voice channel for playlist playback');
          }

          const playlistData = await playlistManager.getPlaylist(playlist.id);
          if (!playlistData || playlistData.tracks.length === 0) {
            await interaction.editReply(`Playlist **${playlist.name}** is empty.`);
            return;
          }

          let enqueuedCount = 0;
          let skippedCount = 0;

          for (const pt of playlistData.tracks) {
            if (!pt.source || !pt.source.sourceUrl) {
              logger.warn({ trackId: pt.trackId, title: pt.track?.title }, '[PLAYLIST] Skipped unavailable track');
              skippedCount++;
              continue;
            }

            const trackPath = pt.source.sourceUrl;
            const isStream =
              pt.source.sourceType === 'stream' ||
              trackPath.startsWith('http://') ||
              trackPath.startsWith('https://');

            const queueTrack: QueueTrack = {
              id: pt.id || pt.trackId,
              trackId: pt.trackId,
              name: pt.track?.title || 'Unknown Track',
              path: trackPath,
              duration: pt.track?.duration ?? undefined,
              artist: pt.track?.artist ?? undefined,
              album: pt.track?.album ?? undefined,
              thumbnailUrl: pt.track?.coverArt ?? undefined,
              sourceProvider: pt.source.provider,
              sourceUrl: trackPath,
              source: pt.source.provider,
              artwork: pt.track?.coverArt ?? undefined,
              addedBy: pt.addedBy || member.displayName || member.user?.username,
              userId,
            };

            const current = playbackManager.getCurrentTrack(guildId);
            const status = playbackManager.getPlaybackStatus(guildId);

            if (!current && status === 'IDLE' && enqueuedCount === 0) {
              const audioSource = isStream
                ? new HttpAudioSource(trackPath, {
                    title: queueTrack.name,
                    artist: queueTrack.artist,
                    album: queueTrack.album,
                    duration: queueTrack.duration,
                  })
                : new LocalAudioSource(trackPath, undefined, probeAudioMetadata);

              await playbackManager.play(guildId, audioSource, queueTrack);
            } else {
              playbackManager.queueManager.addTrack(guildId, queueTrack);
            }
            enqueuedCount++;
          }

          const responseText = skippedCount > 0
            ? `🎶 Enqueued **${enqueuedCount}** tracks from playlist **${playlist.name}** (⚠️ skipped ${skippedCount} unavailable tracks)`
            : `🎶 Enqueued **${enqueuedCount}** tracks from playlist **${playlist.name}**`;

          await interaction.editReply(responseText);
          break;
        }

        case 'add': {
          await interaction.deferReply();
          const name = interaction.options.getString('name', true);
          const trackInput = interaction.options.getString('track', true);

          const playlist = await playlistManager.findPlaylistByName(name, { guildId, userId });
          if (!playlist) {
            await interaction.editReply(`Playlist **${name}** not found.`);
            return;
          }

          // Resolve track via AudioSourceManager & TrackManager
          const srcManager = audioSourceManager || createConfiguredAudioSourceManager();
          let resolvedTrackId: string | null = null;
          let trackTitle = trackInput;

          try {
            if (srcManager.canHandle(trackInput)) {
              const resolved = await srcManager.resolve(trackInput);
              trackTitle = resolved.title;
              if (trackManager) {
                const saved = await trackManager.saveTrackWithSource(resolved.metadata, resolved.source);
                resolvedTrackId = saved.track.id;
              }
            } else {
              const localSource = new LocalAudioSource(trackInput, undefined, probeAudioMetadata);
              await localSource.validate();
              const meta = await localSource.getMetadata();
              trackTitle = meta.title;
              if (trackManager) {
                const saved = await trackManager.saveTrackWithSource(
                  meta,
                  { provider: 'local', sourceType: 'file', sourceUrl: trackInput },
                );
                resolvedTrackId = saved.track.id;
              }
            }
          } catch (err: any) {
            await interaction.editReply(`Could not resolve track: ${err.message}`);
            return;
          }

          if (!resolvedTrackId) {
            await interaction.editReply('Could not save track to database.');
            return;
          }

          const added = await playlistManager.addTrackToPlaylist(
            playlist.id,
            resolvedTrackId,
            member.displayName || member.user?.username,
          );

          await interaction.editReply(
            `✅ Added **${trackTitle}** to playlist **${playlist.name}** at position #${added.position}`,
          );
          break;
        }

        case 'remove': {
          const name = interaction.options.getString('name', true);
          const index = interaction.options.getInteger('index', true);

          const playlist = await playlistManager.findPlaylistByName(name, { guildId, userId });
          if (!playlist) {
            await interaction.reply({ content: `Playlist **${name}** not found.`, ephemeral: true });
            return;
          }

          const removed = await playlistManager.removeTrackFromPlaylist(playlist.id, index);
          if (removed) {
            await interaction.reply(`🗑️ Removed track #${index} from playlist **${playlist.name}**`);
          } else {
            await interaction.reply({ content: `Could not remove track #${index} from playlist.`, ephemeral: true });
          }
          break;
        }

        case 'rename': {
          const name = interaction.options.getString('name', true);
          const newName = interaction.options.getString('new_name', true);

          const playlist = await playlistManager.findPlaylistByName(name, { guildId, userId });
          if (!playlist) {
            await interaction.reply({ content: `Playlist **${name}** not found.`, ephemeral: true });
            return;
          }

          try {
            await playlistManager.renamePlaylist(playlist.id, newName, userId);
            await interaction.reply(`✏️ Renamed playlist **${name}** to **${newName}**`);
          } catch (err: any) {
            await interaction.reply({ content: `Failed to rename playlist: ${err.message}`, ephemeral: true });
          }
          break;
        }

        case 'reorder': {
          const name = interaction.options.getString('name', true);
          const from = interaction.options.getInteger('from', true);
          const to = interaction.options.getInteger('to', true);

          const playlist = await playlistManager.findPlaylistByName(name, { guildId, userId });
          if (!playlist) {
            await interaction.reply({ content: `Playlist **${name}** not found.`, ephemeral: true });
            return;
          }

          try {
            const reordered = await playlistManager.reorderPlaylistTrack(playlist.id, from, to);
            if (reordered) {
              await interaction.reply(`🔀 Reordered track in **${playlist.name}** from #${from} to #${to}`);
            } else {
              await interaction.reply({ content: `Could not reorder track in playlist. Please verify positions.`, ephemeral: true });
            }
          } catch (err: any) {
            await interaction.reply({ content: `Failed to reorder track: ${err.message}`, ephemeral: true });
          }
          break;
        }

        case 'duplicate': {
          const name = interaction.options.getString('name', true);
          const newName = interaction.options.getString('new_name', true);

          const playlist = await playlistManager.findPlaylistByName(name, { guildId, userId });
          if (!playlist) {
            await interaction.reply({ content: `Playlist **${name}** not found.`, ephemeral: true });
            return;
          }

          try {
            const copy = await playlistManager.duplicatePlaylist(playlist.id, newName, userId);
            await interaction.reply(`📑 Successfully duplicated playlist **${playlist.name}** as **${copy.name}** with **${copy.trackCount}** tracks!`);
          } catch (err: any) {
            await interaction.reply({ content: `Failed to duplicate playlist: ${err.message}`, ephemeral: true });
          }
          break;
        }

        case 'delete': {
          const name = interaction.options.getString('name', true);
          const playlist = await playlistManager.findPlaylistByName(name, { guildId, userId });
          if (!playlist) {
            await interaction.reply({ content: `Playlist **${name}** not found.`, ephemeral: true });
            return;
          }

          try {
            await playlistManager.deletePlaylist(playlist.id, userId);
            await interaction.reply(`🗑️ Deleted playlist **${playlist.name}**`);
          } catch (err: any) {
            await interaction.reply({ content: `Failed to delete playlist: ${err.message}`, ephemeral: true });
          }
          break;
        }
      }
      break;
    }

    case 'vibe': {
      if (!recManager) {
        await interaction.reply({ content: 'AI recommendation service is not available.', ephemeral: true });
        return;
      }

      await interaction.deferReply();
      const trackQuery = interaction.options.getString('track');
      const profile = (interaction.options.getString('profile') as DJProfile) || 'BALANCED';

      let seedTrackId: string | undefined;
      let seedTitle = 'Current Track';

      if (trackQuery && trackManager) {
        const found = await trackManager.search(trackQuery, 1);
        if (found.length > 0) {
          seedTrackId = found[0].id;
          seedTitle = found[0].title;
        }
      }

      if (!seedTrackId) {
        const current = playbackManager.getCurrentTrack(guildId);
        if (current && (current as any).trackId) {
          seedTrackId = (current as any).trackId;
          seedTitle = current.name;
        }
      }

      if (!seedTrackId) {
        await interaction.editReply('❌ No seed track specified and nothing is currently playing. Provide a track or play music first.');
        return;
      }

      const recResult = await recManager.generateVibePlaylist(seedTrackId, guildId, 5, profile);
      if (recResult.tracks.length === 0) {
        await interaction.editReply(`🎧 Could not find similar tracks for **${seedTitle}** yet. As more tracks are analyzed, recommendations will populate.`);
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle('🎧 VIBE MATCH')
        .setColor(profile === 'CHILL' ? 0x3498db : profile === 'ENERGETIC' ? 0xe74c3c : 0x9b59b6)
        .setDescription(`Based on: **${seedTitle}**\nProfile: \`${profile}\``);

      const trackList = recResult.tracks
        .map((t, idx) => {
          const reasonStr = t.reasons.length > 0 ? `*${t.reasons.slice(0, 2).join(' • ')}*` : '';
          return `**${idx + 1}. ${t.title}** ${t.artist ? `— ${t.artist}` : ''}\n   └ ${reasonStr}`;
        })
        .join('\n\n');

      embed.addFields({ name: 'Suggested Vibe Queue', value: trackList || 'No tracks found' });

      await interaction.editReply({ embeds: [embed] });
      break;
    }

    case 'smartshuffle': {
      if (!recManager) {
        await interaction.reply({ content: 'AI recommendation service is not available.', ephemeral: true });
        return;
      }

      await interaction.deferReply();
      const profile = (interaction.options.getString('profile') as DJProfile) || 'BALANCED';
      const queue = playbackManager.queueManager.inspectQueue(guildId);
      const current = playbackManager.getCurrentTrack(guildId);

      if (queue.length <= 1) {
        await interaction.editReply('Queue must have at least 2 tracks to perform a smart shuffle.');
        return;
      }

      const shuffled = await recManager.smartShuffle(guildId, queue, current, profile);
      (playbackManager as any).queueManager?.setQueue(guildId, shuffled);

      const embed = new EmbedBuilder()
        .setTitle('🔀 Smart Shuffle Applied')
        .setColor(0x2ecc71)
        .setDescription(`Intelligently reordered **${shuffled.length}** tracks for smooth acoustic energy flow and rhythm continuity.\nProfile: \`${profile}\``);

      await interaction.editReply({ embeds: [embed] });
      break;
    }

    case 'dj': {
      if (!recManager) {
        await interaction.reply({ content: 'Dynamic DJ service is not available.', ephemeral: true });
        return;
      }

      const sub = interaction.options.getSubcommand();

      if (sub === 'on') {
        const profile = (interaction.options.getString('profile') as DJProfile) || 'BALANCED';
        recManager.configureDJ(guildId, { enabled: true, profile });
        await interaction.reply(`🎛️ **Dynamic DJ is now ON**\nProfile: \`${profile}\`\nGakki will automatically select and queue matching tracks when your queue runs low!`);
      } else if (sub === 'off') {
        recManager.configureDJ(guildId, { enabled: false });
        await interaction.reply('🎛️ **Dynamic DJ is now OFF**');
      } else if (sub === 'profile') {
        const profile = interaction.options.getString('name', true) as DJProfile;
        recManager.configureDJ(guildId, { profile });
        await interaction.reply(`🎛️ DJ Profile updated to **${profile}**`);
      } else if (sub === 'status') {
        const state = recManager.getDJState(guildId);
        const embed = new EmbedBuilder()
          .setTitle('🎛️ Dynamic DJ Status')
          .setColor(state.enabled ? 0x2ecc71 : 0x95a5a6)
          .addFields(
            { name: 'Status', value: state.enabled ? '🟢 Enabled' : '⚪ Disabled', inline: true },
            { name: 'Profile', value: `\`${state.profile}\``, inline: true },
            { name: 'Recent History', value: `${state.recentTrackIds.length} tracks cached`, inline: true },
          );

        if (state.lookaheadQueue.length > 0) {
          const queueText = state.lookaheadQueue
            .map((c, i) => `${i + 1}. **${c.title}** ${c.artist ? `(${c.artist})` : ''} — *${c.reasons[0] || 'Vibe match'}*`)
            .join('\n');
          embed.addFields({ name: 'Lookahead Next Queue', value: queueText });
        }

        await interaction.reply({ embeds: [embed] });
      } else if (sub === 'stems') {
        const state = interaction.options.getString('state', true) === 'on';
        playbackManager.setStemSettings(guildId, { stemSeparationEnabled: state });
        await interaction.reply(`🎛️ **DJ Stem Separation is now ${state ? 'ENABLED' : 'DISABLED'}**`);
      } else if (sub === 'vocalduck') {
        const state = interaction.options.getString('state', true) === 'on';
        playbackManager.setStemSettings(guildId, { vocalDucking: state });
        await interaction.reply(`🎛️ **DJ Vocal Ducking is now ${state ? 'ENABLED' : 'DISABLED'}**`);
      }
      break;
    }

    case 'stems': {
      const sub = interaction.options.getSubcommand();
      const trackQuery = interaction.options.getString('track');
      let targetTrackId: string | undefined;
      let targetTitle = 'Current Track';

      if (trackQuery && trackManager) {
        const found = await trackManager.search(trackQuery, 1);
        if (found.length > 0) {
          targetTrackId = found[0].id;
          targetTitle = found[0].title;
        }
      }

      if (!targetTrackId) {
        const current = playbackManager.getCurrentTrack(guildId);
        if (current && (current as any).trackId) {
          targetTrackId = (current as any).trackId;
          targetTitle = current.name;
        }
      }

      if (sub === 'status') {
        const registry = StemProviderRegistry.getInstance();
        const caps = await registry.discoverCapabilities();
        const activeStemSettings = playbackManager.getStemSettings(guildId);

        let stemInfo = 'No track specified or currently playing.';
        if (targetTrackId && playbackManager.stemManager) {
          const stems = await playbackManager.stemManager.getStems(targetTrackId);
          const vocal = await playbackManager.stemManager.getVocalFeatures(targetTrackId);
          if (stems) {
            stemInfo = `**Track:** ${targetTitle}\n**Provider:** \`${stems.provider}\` (${stems.modelName} v${stems.modelVersion})\n**Quality Score:** ${(stems.quality.overallQuality * 100).toFixed(0)}%\n**Vocal Activity:** ${((vocal?.meanVocalActivity ?? 0) * 100).toFixed(0)}%\n**Storage Mode:** \`${stems.storageMode}\``;
          } else {
            stemInfo = `**Track:** ${targetTitle}\n*Stems not yet extracted. Run \`/stems analyze track:${targetTitle}\` to process.*`;
          }
        }

        const embed = new EmbedBuilder()
          .setTitle('🎛️ Stem Separation Status')
          .setColor(activeStemSettings.stemSeparationEnabled ? 0x2ecc71 : 0x95a5a6)
          .addFields(
            { name: 'Stem Mixing', value: activeStemSettings.stemSeparationEnabled ? '🟢 Enabled' : '⚪ Disabled', inline: true },
            { name: 'Vocal Ducking', value: activeStemSettings.vocalDucking ? `🟢 Enabled (${activeStemSettings.vocalDuckDb} dB)` : '⚪ Disabled', inline: true },
            { name: 'Layered Transitions', value: activeStemSettings.layeredTransitions ? '🟢 Enabled' : '⚪ Disabled', inline: true },
            {
              name: 'Available Providers',
              value: Object.entries(caps)
                .map(([name, c]) => `• **${name.toUpperCase()}**: ${c.available ? '✅ Available' : '❌ Unavailable'} (${c.computeBackend.toUpperCase()})`)
                .join('\n') || 'None',
            },
            { name: 'Track Stem Status', value: stemInfo },
          );

        await interaction.reply({ embeds: [embed] });
      } else if (sub === 'analyze') {
        if (!targetTrackId) {
          await interaction.reply({ content: '❌ Please specify a track title or play a track first.', ephemeral: true });
          return;
        }

        const current = playbackManager.getCurrentTrack(guildId);
        const filePath = (current as any)?.path;
        if (!filePath) {
          await interaction.reply({ content: `❌ Cannot locate local audio file for **${targetTitle}**.`, ephemeral: true });
          return;
        }

        const workerPool = StemWorkerPool.getInstance(playbackManager.stemManager);
        const job = workerPool.enqueue(
          { trackId: targetTrackId, filePath, title: targetTitle, duration: current?.duration },
          { quality: 'balanced', storageMode: 'persistent' },
          'HIGH',
        );

        await interaction.reply(`⏳ **Queued stem separation** for **${targetTitle}** (Job: \`${job.id.slice(0, 8)}\`)\nProcessing asynchronously in background...`);
      }
      break;
    }

    case 'transition': {
      const sub = interaction.options.getSubcommand();
      const currentSettings = playbackManager.getTransitionSettings(guildId);

      if (sub === 'on') {
        playbackManager.setTransitionSettings(guildId, { transitionEnabled: true });
        await interaction.reply('🎚️ **DJ Transitions are now **ENABLED****\nTracks will seamlessly crossfade with loudness normalization and beat alignment!');
      } else if (sub === 'off') {
        playbackManager.setTransitionSettings(guildId, { transitionEnabled: false });
        await interaction.reply('🎚️ **DJ Transitions are now **DISABLED**** (using hard cuts)');
      } else if (sub === 'duration') {
        const seconds = interaction.options.getInteger('seconds') ?? interaction.options.getInteger('duration') ?? 6;
        if (seconds < 1 || seconds > 8) {
          await interaction.reply({ content: '⚠️ Duration must be between 1 and 8 seconds.', ephemeral: true });
          return;
        }
        playbackManager.setTransitionSettings(guildId, { transitionDuration: seconds });
        await interaction.reply(`🎚️ DJ crossfade duration set to **${seconds}s**.`);
      } else if (sub === 'profile') {
        const raw = (interaction.options.getString('name') ?? interaction.options.getString('profile') ?? 'BALANCED').toUpperCase();
        if (!['SMOOTH', 'BALANCED', 'ENERGETIC'].includes(raw)) {
          await interaction.reply({ content: '⚠️ Profile must be SMOOTH, BALANCED, or ENERGETIC.', ephemeral: true });
          return;
        }
        playbackManager.setTransitionSettings(guildId, { transitionProfile: raw as any });
        await interaction.reply(`🎚️ DJ transition profile set to **${raw}**.`);
      } else if (sub === 'status') {
        const s = playbackManager.getTransitionSettings(guildId);
        const caps = getFFmpegCapabilities();
        const prepared = playbackManager.getPreparedTransition(guildId);

        const embed = new EmbedBuilder()
          .setTitle('🎚️ DJ Transition Settings & Status')
          .setColor(s.transitionEnabled ? 0x2ecc71 : 0x95a5a6)
          .addFields(
            { name: 'Status', value: s.transitionEnabled ? '🟢 Enabled' : '⚪ Disabled', inline: true },
            { name: 'Duration', value: `${s.transitionDuration}s`, inline: true },
            { name: 'Profile', value: `\`${s.transitionProfile}\``, inline: true },
            { name: 'Harmonic Mixing', value: s.harmonicMixing ? '✅ Yes' : '❌ No', inline: true },
            { name: 'Auto Tempo', value: s.autoTempo ? '✅ Yes' : '❌ No', inline: true },
            { name: 'Loudness Normalization', value: s.loudnessNormalize ? '✅ Yes' : '❌ No', inline: true },
            {
              name: 'FFmpeg Capabilities',
              value: `RubberBand: ${caps?.rubberband ? '✅' : '❌'} | Acrossfade: ${caps?.acrossfade ? '✅' : '❌'} | Loudnorm: ${caps?.loudnorm ? '✅' : '❌'}`,
            },
          );

        if (prepared) {
          embed.addFields({
            name: 'Prepared Transition',
            value: `Next: **${prepared.nextTrack.name}**\nCue: ${prepared.plan.outgoingCueSeconds}s | Score: ${(prepared.plan.score * 100).toFixed(0)}% | Level: \`${prepared.plan.fallbackLevel}\``,
          });
        }

        await interaction.reply({ embeds: [embed] });
      }
      break;
    }

    case 'lyrics': {
      await interaction.deferReply();
      const trackQuery = interaction.options.getString('track');
      let targetTrack: { title: string; artist?: string | null; album?: string | null; duration?: number | null; id?: string } | null = null;

      if (trackQuery) {
        targetTrack = { title: trackQuery };
      } else {
        const current = playbackManager.getCurrentTrack(guildId);
        if (!current) {
          await interaction.editReply('⚠️ No track is currently playing. Specify a track name or play a song first.');
          return;
        }
        targetTrack = {
          title: current.name,
          artist: current.artist,
          album: current.album,
          duration: current.duration,
          id: current.trackId,
        };
      }

      if (!lyricsManager) {
        await interaction.editReply('⚠️ Lyrics service is not available.');
        return;
      }

      try {
        const result = await lyricsManager.getLyrics(targetTrack, targetTrack.id);
        if (!result || !result.plainLyrics) {
          await interaction.editReply('⚠️ Lyrics unavailable.');
          return;
        }

        const { excerpt, isTruncated } = lyricsManager.formatLyricsExcerpt(result.plainLyrics, 1800);
        const embed = new EmbedBuilder()
          .setTitle(`🎶 Lyrics: ${targetTrack.title}${targetTrack.artist ? ` — ${targetTrack.artist}` : ''}`)
          .setDescription(excerpt)
          .setColor(0x3498db)
          .setFooter({
            text: `Provider: ${result.providerName.toUpperCase()} • Confidence: ${(result.confidence * 100).toFixed(0)}%${result.isSynced ? ' • ⏱️ Synced Lyrics Available on Web Dashboard' : ''}`,
          });

        if (isTruncated) {
          embed.addFields({
            name: 'Web Dashboard',
            value: 'Full unsynced and synchronized lyrics are available on the [Web Dashboard](http://localhost:3000).',
          });
        }

        await interaction.editReply({ embeds: [embed] });
      } catch (err: any) {
        logger.error({ err, targetTrack }, 'Failed to fetch lyrics in Discord command');
        await interaction.editReply('❌ Failed to retrieve lyrics for this track.');
      }
      break;
    }

    case 'favorite': {
      const trackQuery = interaction.options.getString('track');
      let targetTrackId: string | null = null;
      let targetTitle: string = '';

      if (trackQuery) {
        if (trackManager) {
          const found = await trackManager.search(trackQuery, 1);
          if (found.length > 0) {
            targetTrackId = found[0].id;
            targetTitle = found[0].title;
          }
        }
      } else {
        const current = playbackManager.getCurrentTrack(guildId);
        if (current && current.trackId) {
          targetTrackId = current.trackId;
          targetTitle = current.name;
        }
      }

      if (!targetTrackId) {
        await interaction.reply({
          content: '⚠️ No track specified and nothing is currently playing to favorite.',
          ephemeral: true,
        });
        return;
      }

      if (!favoritesManager) {
        await interaction.reply({ content: '⚠️ Favorites service is currently unavailable.', ephemeral: true });
        return;
      }

      try {
        await favoritesManager.addFavorite(interaction.user.id, targetTrackId);
        await interaction.reply(`⭐ Added **${targetTitle}** to your favorites! View your collection with \`/favorites\`.`);
      } catch (err: any) {
        await interaction.reply({ content: `❌ Failed to favorite track: ${err.message}`, ephemeral: true });
      }
      break;
    }

    case 'unfavorite': {
      const trackQuery = interaction.options.getString('track');
      let targetTrackId: string | null = null;
      let targetTitle: string = '';

      if (trackQuery) {
        if (trackManager) {
          const found = await trackManager.search(trackQuery, 1);
          if (found.length > 0) {
            targetTrackId = found[0].id;
            targetTitle = found[0].title;
          }
        }
      } else {
        const current = playbackManager.getCurrentTrack(guildId);
        if (current && current.trackId) {
          targetTrackId = current.trackId;
          targetTitle = current.name;
        }
      }

      if (!targetTrackId) {
        await interaction.reply({
          content: '⚠️ No track specified and nothing is currently playing to unfavorite.',
          ephemeral: true,
        });
        return;
      }

      if (!favoritesManager) {
        await interaction.reply({ content: '⚠️ Favorites service is currently unavailable.', ephemeral: true });
        return;
      }

      try {
        await favoritesManager.removeFavorite(interaction.user.id, targetTrackId);
        await interaction.reply(`🗑️ Removed **${targetTitle}** from your personal favorites.`);
      } catch (err: any) {
        await interaction.reply({ content: `❌ Failed to remove favorite: ${err.message}`, ephemeral: true });
      }
      break;
    }

    case 'favorites': {
      if (!favoritesManager) {
        await interaction.reply({ content: '⚠️ Favorites service is currently unavailable.', ephemeral: true });
        return;
      }

      await interaction.deferReply();
      const page = interaction.options.getInteger('page') || 1;
      const limit = 10;

      try {
        const result = await favoritesManager.getFavorites(interaction.user.id, { page, limit });
        if (result.items.length === 0) {
          await interaction.editReply('⭐ You have no favorited tracks yet. Use `/favorite` to save songs you love!');
          return;
        }

        const totalPages = Math.ceil(result.total / limit);
        const listText = result.items
          .map((fav, i) => {
            const num = (page - 1) * limit + i + 1;
            const dur = fav.track?.duration ? ` \`(${formatDuration(fav.track.duration)})\`` : '';
            const artist = fav.track?.artist ? ` — *${fav.track.artist}*` : '';
            return `**${num}.** ${fav.track?.title || 'Unknown Track'}${artist}${dur}`;
          })
          .join('\n');

        const embed = new EmbedBuilder()
          .setTitle(`⭐ Your Favorite Tracks (Page ${page}/${totalPages})`)
          .setDescription(listText)
          .setColor(0xf1c40f)
          .setFooter({ text: `Total: ${result.total} favorites • Use /play with any title to listen` });

        await interaction.editReply({ embeds: [embed] });
      } catch (err: any) {
        await interaction.editReply({ content: `❌ Failed to load favorites: ${err.message}` });
      }
      break;
    }

    case 'help': {
      const category = interaction.options.getString('category');
      const embed = new EmbedBuilder()
        .setTitle('🎵 Gakki Music Platform — Command Guide')
        .setColor(0x9b59b6)
        .setFooter({ text: 'Gakki v0.10.0 • Web Dashboard: http://localhost:3000' });

      if (!category || category === 'playback') {
        embed.addFields({
          name: '🎵 Playback',
          value:
            '`/play [input]` - Play local song, audio URL, or SoundCloud link\n' +
            '`/pause` & `/resume` - Pause or unpause audio\n' +
            '`/skip` - Skip to next track in queue\n' +
            '`/queue` - View active queue and now playing track\n' +
            '`/nowplaying` - Detailed view of current song\n' +
            '`/leave` - Stop playback and leave voice channel',
        });
      }

      if (!category || category === 'playlists') {
        embed.addFields({
          name: '📑 Playlists',
          value:
            '`/playlist list` - View your saved playlists\n' +
            '`/playlist play <name>` - Queue an entire playlist\n' +
            '`/playlist create <name>` - Create a new playlist\n' +
            '`/playlist add <name> <track>` - Add track to playlist\n' +
            '`/playlist remove <name> <index>` - Remove track by position\n' +
            '`/playlist reorder <name> <from> <to>` - Move track position\n' +
            '`/playlist duplicate <name> <new_name>` - Copy a playlist\n' +
            '`/playlist rename <name> <new_name>` - Rename playlist',
        });
      }

      if (!category || category === 'dj') {
        embed.addFields({
          name: '🎛️ DJ & Transitions',
          value:
            '`/dj on [profile]` - Enable dynamic AI DJ auto-selection\n' +
            '`/dj off` - Disable dynamic DJ\n' +
            '`/smartshuffle` - Flow-aware intelligent queue shuffle\n' +
            '`/transition on/off` - Toggle seamless beat-aware crossfading\n' +
            '`/transition profile <name>` - Set profile (Smooth/Balanced/Energetic)\n' +
            '`/stems status` - View stem separation & vocal protection',
        });
      }

      if (!category || category === 'library') {
        embed.addFields({
          name: '📚 Library & Lyrics',
          value:
            '`/search <query>` - Search songs across local library\n' +
            '`/lyrics [track]` - Look up plain and synced song lyrics\n' +
            '`/favorite [track]` - Add song to your personal favorites\n' +
            '`/unfavorite [track]` - Remove song from your favorites\n' +
            '`/favorites [page]` - List your saved favorite tracks\n' +
            '`/history` & `/recent` - View recent playback log',
        });
      }

      if (!category || category === 'settings') {
        embed.addFields({
          name: '⚙️ Audio Effects & Settings',
          value:
            '`/volume <level>` - Set volume level (0-200%)\n' +
            '`/loop <mode>` - Set loop mode (off/track/queue)\n' +
            '`/bassboost <on/off>` - Toggle low-end bass filter\n' +
            '`/speed <value>` - Adjust playback speed (0.5x - 2.0x)\n' +
            '`/nightcore <on/off>` - Toggle nightcore pitch shift',
        });
      }

      await interaction.reply({ embeds: [embed] });
      break;
    }

    default:
      await interaction.reply({ content: 'Unknown command.', ephemeral: true });
  }
}
