import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
  type GuildMember,
  PermissionsBitField,
} from 'discord.js';
import type { AudioPlayerManager, PlaybackManager, QueueTrack, LoopMode } from '@gakki/core';
import {
  LocalAudioSource,
  VoicePermissionError,
  createLogger,
} from '@gakki/core';
import { probeAudioMetadata } from '../audio/ffmpeg';
import { listLocalAudioFiles, listLocalFolders } from '../audio/local-files';
import { enqueueFolder, enqueueMultipleFiles } from '../audio/batch-loader';

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
    .setDescription('Play a local audio file or add to queue if already playing')
    .addStringOption((option) =>
      option
        .setName('file')
        .setDescription('File name in storage/music (e.g. test.mp3)')
        .setRequired(false)
        .setAutocomplete(true),
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
        .addChoices(
          { name: 'On', value: 'on' },
          { name: 'Off', value: 'off' },
        ),
    ),
];

/**
 * Handle slash command autocompletion for /play and /addqueue options.
 */
export async function handleAutocomplete(
  interaction: AutocompleteInteraction,
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
  }
}

/**
 * Handle incoming chat input slash commands.
 */
export async function handleChatInputCommand(
  interaction: ChatInputCommandInteraction,
  manager: PlaybackManager | AudioPlayerManager,
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

      // Determine file to play
      let inputFileName = interaction.options.getString('file');
      if (!inputFileName || inputFileName.trim() === '') {
        const available = await listLocalAudioFiles();
        if (available.length === 0) {
          await interaction.editReply('No local audio files found in storage/music directory.');
          return;
        }
        inputFileName = available[0];
      }

      const source = new LocalAudioSource(inputFileName, undefined, probeAudioMetadata);

      try {
        await source.validate();
      } catch (err: any) {
        logger.warn({ err, file: inputFileName }, '[AUDIO] File validation failed');
        await interaction.editReply(err.message || `File error for: ${inputFileName}`);
        return;
      }

      try {
        const metadata = await source.getMetadata();
        const durationStr = formatDuration(metadata.duration);

        const playResult = await playbackManager.play(guildId, source, {
          name: metadata.title,
          path: inputFileName,
          duration: metadata.duration ?? undefined,
          artist: metadata.artist,
          addedBy: member.displayName || member.user?.username,
        });

        if (playResult.status === 'started') {
          await interaction.editReply(
            `▶️ Started: **${metadata.title}**${metadata.artist ? ` by **${metadata.artist}**` : ''} \`[${durationStr}]\``,
          );
        } else {
          await interaction.editReply(
            `➕ Added to queue: **${metadata.title}**${metadata.artist ? ` by **${metadata.artist}**` : ''}\nPosition: **${playResult.position}**`,
          );
        }
      } catch (error) {
        logger.error({ err: error, guildId }, '[ERROR] Playback failed');
        await interaction.editReply(`Playback failed: ${(error as Error).message}`);
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
      await interaction.reply({
        content: `**Now Playing:** ${currentTrack.name}${currentTrack.artist ? ` — *${currentTrack.artist}*` : ''}\n**Status:** ${state.playerState}\n**Duration:** \`${durationStr}\``,
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

    default:
      await interaction.reply({ content: 'Unknown command.', ephemeral: true });
  }
}
