import { Client, GatewayIntentBits } from 'discord.js';
import type {
  AudioPlayerManager,
  PlaybackManager,
  AudioSourceManager,
  AnalyticsManager,
  PlaylistManager,
  TrackManager,
  AiRecommendationManager,
  LyricsManager,
  FavoritesManager,
  RecordingManager,
} from '@gakki/core';
import { createLogger } from '@gakki/core';
import {
  slashCommandDefinitions,
  handleChatInputCommand,
  handleAutocomplete,
} from './commands';
import type { VoiceReceiverManager } from '../voice';

const logger = createLogger('discord');

let client: Client | null = null;

/**
 * Create and connect the Discord bot client.
 *
 * Registers only the minimal intents needed:
 * - Guilds: required for guild membership
 * - GuildVoiceStates: required for voice channel operations
 *
 * @param token - Discord bot token
 * @param playbackManager - Optional PlaybackManager or AudioPlayerManager for handling voice commands
 * @param audioSourceManager - Optional AudioSourceManager for resolving internet and local sources
 * @param analyticsManager - Optional AnalyticsManager for playback history and metrics
 * @param playlistManager - Optional PlaylistManager for saved playlists
 * @param trackManager - Optional TrackManager for persistent tracks
 * @param recManager - Optional AiRecommendationManager
 * @param lyricsManager - Optional LyricsManager
 * @param favoritesManager - Optional FavoritesManager
 * @returns The connected Discord.js Client
 */
export async function createDiscordBot(
  token: string,
  playbackManager?: PlaybackManager | AudioPlayerManager,
  audioSourceManager?: AudioSourceManager,
  analyticsManager?: AnalyticsManager,
  playlistManager?: PlaylistManager,
  trackManager?: TrackManager,
  recManager?: AiRecommendationManager,
  lyricsManager?: LyricsManager,
  favoritesManager?: FavoritesManager,
  recordingManager?: RecordingManager,
  voiceReceiver?: VoiceReceiverManager,
): Promise<Client> {
  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
    ],
  });

  const activeManager: PlaybackManager | undefined =
    playbackManager && 'playbackManager' in playbackManager
      ? (playbackManager as AudioPlayerManager).playbackManager
      : (playbackManager as PlaybackManager | undefined);

  client.once('ready', async (readyClient) => {
    logger.info(
      { tag: readyClient.user.tag, guilds: readyClient.guilds.cache.size },
      'Discord bot ready',
    );

    // Register slash commands
    try {
      logger.info('Registering slash commands with Discord API...');
      await readyClient.application.commands.set(slashCommandDefinitions);
      logger.info('Global slash commands registered successfully');

      for (const guild of readyClient.guilds.cache.values()) {
        try {
          await guild.commands.set(slashCommandDefinitions);
          logger.debug({ guildId: guild.id }, 'Guild slash commands registered');
        } catch (gErr) {
          logger.warn({ err: gErr, guildId: guild.id }, 'Failed to set commands on guild');
        }
      }
    } catch (cmdErr) {
      logger.error({ err: cmdErr }, 'Failed to register slash commands');
    }
  });

  client.on('guildCreate', async (guild) => {
    try {
      await guild.commands.set(slashCommandDefinitions);
      logger.info({ guildId: guild.id, name: guild.name }, 'Slash commands registered on joined guild');
    } catch (err) {
      logger.warn({ err, guildId: guild.id }, 'Failed to register commands on new guild');
    }
  });

  client.on('interactionCreate', async (interaction) => {
    if (!activeManager) return;

    try {
      if (interaction.isAutocomplete()) {
        await handleAutocomplete(interaction, playlistManager);
      } else if (interaction.isChatInputCommand()) {
        await handleChatInputCommand(
          interaction,
          activeManager,
          audioSourceManager,
          analyticsManager,
          playlistManager,
          trackManager,
          recManager,
          lyricsManager,
          favoritesManager,
          recordingManager,
          voiceReceiver,
        );
      }
    } catch (err) {
      logger.error({ err }, '[ERROR] Unhandled error during interaction');
      if (interaction.isRepliable()) {
        const errorMsg = 'An unexpected error occurred while executing this command.';
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply(errorMsg).catch(() => {});
        } else {
          await interaction.reply({ content: errorMsg, ephemeral: true }).catch(() => {});
        }
      }
    }
  });

  client.on('voiceStateUpdate', (oldState, newState) => {
    if (!activeManager) return;
    const guildId = newState.guild?.id || oldState.guild?.id;
    if (!guildId) return;

    // Check if bot is currently connected to a voice channel in this guild
    const botChannelId = newState.guild?.members.me?.voice.channelId;
    if (!botChannelId) return;

    // If someone joined or left the bot's voice channel, update human count
    if (oldState.channelId === botChannelId || newState.channelId === botChannelId) {
      const channel = newState.guild.channels.cache.get(botChannelId);
      if (channel && channel.isVoiceBased()) {
        const humanCount = channel.members.filter((m) => !m.user.bot).size;
        activeManager.voiceLifecycleManager.handleHumanCountChange(guildId, humanCount);
      }
    }
  });

  client.on('error', (error) => {
    logger.error({ err: error }, 'Discord client error');
  });

  client.on('warn', (message) => {
    logger.warn({ message }, 'Discord client warning');
  });

  await client.login(token);
  return client;
}

/** Get the Discord client instance, or null if not started */
export function getDiscordClient(): Client | null {
  return client;
}

/** Check if the Discord bot is connected and ready */
export function isDiscordConnected(): boolean {
  return client?.isReady() ?? false;
}
