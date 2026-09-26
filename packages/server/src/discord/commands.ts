import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
  type GuildMember,
  PermissionsBitField,
} from 'discord.js';
import type { AudioPlayerManager } from '@gakki/core';
import {
  LocalAudioSource,
  VoiceChannelRequiredError,
  VoicePermissionError,
  createLogger,
} from '@gakki/core';
import { probeAudioMetadata } from '../audio/ffmpeg';
import { listLocalAudioFiles } from '../audio/local-files';

const logger = createLogger('discord-commands');

/**
 * Format duration in seconds to M:SS.
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return 'Unknown';
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
    .setDescription('Play a local audio file')
    .addStringOption((option) =>
      option
        .setName('file')
        .setDescription('File name in storage/music (e.g. test.mp3)')
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
    .setDescription('Stop the current track'),

  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Stop playback and leave the voice channel'),

  new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Show information about the currently playing track'),
];

/**
 * Handle slash command autocompletion for /play file option.
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
  }
}

/**
 * Handle incoming chat input slash commands.
 */
export async function handleChatInputCommand(
  interaction: ChatInputCommandInteraction,
  playerManager: AudioPlayerManager,
): Promise<void> {
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
        await playerManager.join(guildId, userVoiceChannel.id);
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

      // Check if user is in a voice channel
      const currentState = playerManager.getState(guildId);
      if (currentState.voiceState !== 'CONNECTED') {
        if (!userVoiceChannel) {
          await interaction.editReply('You must be in a voice channel to play music.');
          return;
        }

        // Check permissions before joining
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
          await playerManager.join(guildId, userVoiceChannel.id);
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
        inputFileName = available[0]; // defaults to first available file, e.g. test.mp3
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
        await playerManager.play(guildId, source);

        const durationStr = formatDuration(metadata.duration);
        await interaction.editReply(
          `Now playing: **${metadata.title}**${metadata.artist ? ` by **${metadata.artist}**` : ''} \`[${durationStr}]\``,
        );
      } catch (error) {
        logger.error({ err: error, guildId }, '[ERROR] Playback failed');
        await interaction.editReply(`Playback failed: ${(error as Error).message}`);
      }
      break;
    }

    case 'pause': {
      const state = playerManager.getState(guildId);
      if (state.playerState !== 'PLAYING') {
        await interaction.reply({
          content: 'No audio is currently playing.',
          ephemeral: true,
        });
        return;
      }

      const paused = playerManager.pause(guildId);
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
      const state = playerManager.getState(guildId);
      if (state.playerState !== 'PAUSED') {
        await interaction.reply({
          content: 'Audio is not currently paused.',
          ephemeral: true,
        });
        return;
      }

      const resumed = playerManager.resume(guildId);
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
      const state = playerManager.getState(guildId);
      if (state.playerState === 'IDLE') {
        await interaction.reply({
          content: 'No audio is currently playing to skip.',
          ephemeral: true,
        });
        return;
      }

      playerManager.skip(guildId);
      await interaction.reply('Track skipped (stopped).');
      break;
    }

    case 'leave': {
      const state = playerManager.getState(guildId);
      if (state.voiceState === 'DISCONNECTED') {
        await interaction.reply({
          content: 'Not currently connected to any voice channel.',
          ephemeral: true,
        });
        return;
      }

      await playerManager.leave(guildId);
      await interaction.reply('Disconnected from voice channel.');
      break;
    }

    case 'nowplaying': {
      const state = playerManager.getState(guildId);
      if (!state.track || state.playerState === 'IDLE') {
        await interaction.reply('Nothing is currently playing.');
        return;
      }

      const durationStr = formatDuration(state.track.duration);
      await interaction.reply({
        content: `**Now Playing:** ${state.track.name}${state.track.artist ? ` — *${state.track.artist}*` : ''}\n**Status:** ${state.playerState}\n**Duration:** \`${durationStr}\``,
      });
      break;
    }

    default:
      await interaction.reply({ content: 'Unknown command.', ephemeral: true });
  }
}
