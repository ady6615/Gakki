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
    const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${readyClient.user.id}&permissions=8&scope=bot%20applications.commands`;

    logger.info(
      {
        tag: readyClient.user.tag,
        guildCount: readyClient.guilds.cache.size,
        guilds: readyClient.guilds.cache.map((g) => ({ id: g.id, name: g.name })),
        inviteUrl,
      },
      'Discord bot ready — bot can join multiple servers using inviteUrl',
    );

    console.log('\n======================================================');
    console.log(`🤖 Gakki Discord Bot Ready! (${readyClient.user.tag})`);
    console.log(`🌐 Connected to ${readyClient.guilds.cache.size} server(s):`);
    readyClient.guilds.cache.forEach((g) => console.log(`   - ${g.name} (ID: ${g.id})`));
    console.log('\n🔗 INVITE TO MULTIPLE SERVERS:');
    console.log(`   ${inviteUrl}`);
    console.log('======================================================\n');

    // Register slash commands globally (propagates to all joined & future guilds)
    try {
      logger.info('Registering slash commands globally with Discord API...');
      await readyClient.application.commands.set(slashCommandDefinitions);
      logger.info('Global slash commands registered successfully');

      // Clean up any old guild-level duplicate commands so commands only show up once
      for (const guild of readyClient.guilds.cache.values()) {
        try {
          const existing = await guild.commands.fetch().catch(() => null);
          if (existing && existing.size > 0) {
            await guild.commands.set([]);
            logger.debug({ guildId: guild.id }, 'Cleaned up duplicate guild-level slash commands');
          }
        } catch {
          // Ignored if lacking command management permissions in this guild
        }
      }
    } catch (cmdErr) {
      logger.error({ err: cmdErr }, 'Failed to register global slash commands');
    }
  });

  client.on('guildCreate', async (guild) => {
    logger.info({ guildId: guild.id, name: guild.name, members: guild.memberCount }, 'Joined new Discord server!');
    // Global commands are already available in all joined guilds.
    // Clean up any local commands so Discord uses global commands without duplicates.
    try {
      const existing = await guild.commands.fetch().catch(() => null);
      if (existing && existing.size > 0) {
        await guild.commands.set([]);
      }
    } catch {
      // Ignored
    }
  });

  client.on('guildDelete', (guild) => {
    logger.info({ guildId: guild.id, name: guild.name }, 'Removed from Discord server');
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

  client.on('voiceStateUpdate', async (oldState, newState) => {
    if (!activeManager) return;
    const guild = newState.guild || oldState.guild;
    const guildId = guild?.id;
    if (!guildId) return;

    // Check if bot is currently connected to a voice channel in this guild
    const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
    const botChannelId = me?.voice.channelId;
    if (!botChannelId) return;

    // If someone joined or left the bot's voice channel, update human count
    if (oldState.channelId === botChannelId || newState.channelId === botChannelId) {
      let humanCount = 0;
      if (guild) {
        for (const [userId, vs] of guild.voiceStates.cache) {
          if (vs.channelId === botChannelId) {
            if (userId === client?.user?.id) continue;
            const user = client?.users.cache.get(userId) || vs.member?.user;
            if (user?.bot) continue;
            humanCount++;
          }
        }
      }
      activeManager.voiceLifecycleManager.handleHumanCountChange(guildId, humanCount);
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
