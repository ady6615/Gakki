import { Client, GatewayIntentBits } from 'discord.js';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
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
  formatDuration,
} from './commands';
import {
  handleControlPanelButton,
  handleControlPanelSelectMenu,
  handleControlPanelModal,
  spawnControlPanelInChannel,
  refreshPanel,
} from './control-panel';
import { handleQuickPlayInteraction, buildQuickPlayMenu } from './quickplay-menu';
import { handleSongChoiceInteraction } from './song-selector';
import type { VoiceReceiverManager } from '../voice';
import { resolveAnyAudioInput } from '../audio/track-resolver';
import { createConfiguredAudioSourceManager } from '../sources';
import { probeAudioMetadata } from '../audio/ffmpeg';

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
      GatewayIntentBits.GuildMessages,
    ],
  });

  const activeManager: PlaybackManager | undefined =
    playbackManager && 'playbackManager' in playbackManager
      ? (playbackManager as AudioPlayerManager).playbackManager
      : (playbackManager as PlaybackManager | undefined);

  // Hook playback events to auto-refresh any active Discord control panels
  if (activeManager) {
    if (audioSourceManager) {
      activeManager.setAudioSourceResolver(async (input: string) => {
        const resolved = await resolveAnyAudioInput(input, audioSourceManager, trackManager);
        return {
          path: resolved.path,
          name: resolved.name,
          duration: resolved.duration,
          artist: resolved.artist,
          album: resolved.album,
          thumbnailUrl: resolved.thumbnailUrl,
        };
      });
    }

    activeManager.onStateChange((state) => {
      refreshPanel(state.guildId, activeManager).catch(() => {});
    });
    activeManager.onQueueUpdate((event) => {
      refreshPanel(event.guildId, activeManager).catch(() => {});
    });
    activeManager.onPlaybackSettingsUpdate((event: any) => {
      refreshPanel(event.guildId, activeManager).catch(() => {});
    });
  }

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

      // Register commands directly to each joined guild for INSTANT availability (bypasses global cache delay)
      try {
        const oauthGuilds = await readyClient.guilds.fetch();
        for (const [guildId, oauthGuild] of oauthGuilds) {
          try {
            const guild = await oauthGuild.fetch();
            await guild.commands.set(slashCommandDefinitions);
            logger.info({ guildId: guild.id, name: guild.name }, 'Registered slash commands to guild immediately');
          } catch (guildErr) {
            logger.warn({ guildId, err: guildErr }, 'Could not set guild slash commands directly');
          }
        }
      } catch (fetchErr) {
        logger.warn({ err: fetchErr }, 'Could not fetch guilds for slash command registration');
      }
    } catch (cmdErr) {
      logger.error({ err: cmdErr }, 'Failed to register global slash commands');
    }

    // Synchronize bot avatar from 1080pxLogo.png if file updated
    try {
      const avatarCandidates = [
        path.resolve(process.cwd(), 'assets', '1080pxLogo.png'),
        path.resolve(__dirname, '..', '..', '..', '..', 'assets', '1080pxLogo.png'),
        path.resolve(__dirname, '..', '..', '..', 'assets', '1080pxLogo.png'),
      ];
      const avatarPath = avatarCandidates.find((p) => fs.existsSync(p));
      if (avatarPath) {
        const hashDir = path.resolve(process.cwd(), 'storage', 'cache');
        const hashFile = path.join(hashDir, 'bot-avatar.hash');
        const fileBuf = fs.readFileSync(avatarPath);
        const fileHash = crypto.createHash('md5').update(fileBuf).digest('hex');
        let currentCachedHash = '';
        if (fs.existsSync(hashFile)) {
          currentCachedHash = fs.readFileSync(hashFile, 'utf8').trim();
        }
        if (!readyClient.user.avatar || currentCachedHash !== fileHash) {
          logger.info({ avatarPath, fileHash }, 'Updating Discord bot avatar from 1080pxLogo.png...');
          await readyClient.user.setAvatar(avatarPath);
          fs.mkdirSync(hashDir, { recursive: true });
          fs.writeFileSync(hashFile, fileHash, 'utf8');
          logger.info('Discord bot avatar updated successfully');
        }
      }
    } catch (avatarErr) {
      logger.debug({ err: avatarErr }, 'Could not automatically set bot avatar (may already be set or rate-limited)');
    }

    if (playlistManager) {
      playlistManager.cleanupExpiredPlaylists(2).catch(() => {});
      setInterval(() => {
        playlistManager.cleanupExpiredPlaylists(2).catch(() => {});
      }, 12 * 60 * 60 * 1000).unref();
    }
  });

  client.on('guildCreate', async (guild) => {
    logger.info({ guildId: guild.id, name: guild.name, members: guild.memberCount }, 'Joined new Discord server!');
    try {
      await guild.commands.set(slashCommandDefinitions);
      logger.info({ guildId: guild.id }, 'Registered slash commands to newly joined guild');
    } catch (err) {
      logger.warn({ guildId: guild.id, err }, 'Failed to register slash commands on guild join');
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
      } else if (
        (interaction.isButton() || interaction.isStringSelectMenu()) &&
        (interaction.customId.startsWith('gakki:play_select:') || interaction.customId.startsWith('gakki:play_pick:'))
      ) {
        await handleSongChoiceInteraction(interaction, {
          playbackManager: activeManager,
          audioSourceManager,
          trackManager,
        });
      } else if (
        (interaction.isButton() || interaction.isStringSelectMenu()) &&
        interaction.customId.startsWith('gakki:qp:')
      ) {
        await handleQuickPlayInteraction(interaction as any, {
          playbackManager: activeManager,
          audioSourceManager,
          analyticsManager,
          playlistManager,
          trackManager,
          recManager,
        });
      } else if (interaction.isButton() && interaction.customId.startsWith('gakki:')) {
        await handleControlPanelButton(interaction, activeManager);
      } else if (interaction.isStringSelectMenu() && interaction.customId.startsWith('gakki:')) {
        await handleControlPanelSelectMenu(interaction, activeManager);
      } else if (
        interaction.isModalSubmit() &&
        (interaction.customId === 'gakki:play_modal' || interaction.customId === 'gakki:playnext_modal')
      ) {
        // Handle the play / playnext modal from the control panel
        const isPlayNext = interaction.customId === 'gakki:playnext_modal';
        const input = await handleControlPanelModal(interaction);
        if (input && interaction.guildId) {
          const modalCmdInteraction = {
            ...interaction,
            isChatInputCommand: () => true,
            commandName: isPlayNext ? 'playnext' : 'play',
            deferReply: (opts?: any) => interaction.deferReply(opts),
            editReply: (opts: any) => interaction.editReply(opts),
            reply: (opts: any) => interaction.reply(opts),
            followUp: (opts: any) => interaction.followUp(opts),
            options: {
              getString: (name: string) => input,
              getInteger: () => null,
              getBoolean: () => null,
              getNumber: () => null,
              getUser: () => null,
              getChannel: () => null,
              getRole: () => null,
              getMentionable: () => null,
              getSubcommand: () => null,
              getSubcommandGroup: () => null,
            },
          };

          await handleChatInputCommand(
            modalCmdInteraction as any,
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
          return;
        }
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

  // Listen for text triggers: bot mention (@Gakki), !panel, !gakki, !menu, /play, !play
  client.on('messageCreate', async (message) => {
    if (!activeManager || message.author.bot || !message.guildId) return;

    const botId = client?.user?.id;
    const isMentioned = botId && message.mentions.users.has(botId);
    const rawContent = message.content.trim();
    const content = rawContent.toLowerCase();
    const isMenuTrigger = isMentioned || content === '!gakki' || content === '!menu' || content === '!quickplay';
    const isPanelTrigger = content === '!panel' || content === '!control' || content === '!player';

    // Support text commands: /play, !play, /playnext, !playnext directly in chat without typing "song"
    const isPlayMatch = /^(\/|!)play(\s+.*)?$/i.test(rawContent);
    const isPlayNextMatch = /^(\/|!)playnext(\s+.*)?$/i.test(rawContent);

    if (isPlayMatch || isPlayNextMatch) {
      const isPlayNext = isPlayNextMatch;
      let query = rawContent.replace(/^(\/|!)play(next)?\s*/i, '').trim();
      // If user typed "song <query>", strip the extra "song " word too
      if (/^song\s+/i.test(query)) {
        query = query.replace(/^song\s+/i, '').trim();
      }

      let replyMsg: any = null;
      const textInteraction = {
        isChatInputCommand: () => true,
        commandName: isPlayNext ? 'playnext' : 'play',
        guildId: message.guildId,
        guild: message.guild,
        channel: message.channel,
        member: message.member,
        user: message.author,
        client: message.client,
        deferReply: async () => {
          if ('sendTyping' in message.channel) {
            await message.channel.sendTyping().catch(() => {});
          }
        },
        editReply: async (options: any) => {
          const payload = typeof options === 'string' ? { content: options } : options;
          if (replyMsg) {
            return await replyMsg.edit(payload);
          } else {
            replyMsg = await message.channel.send(payload);
            return replyMsg;
          }
        },
        reply: async (options: any) => {
          const payload = typeof options === 'string' ? { content: options } : options;
          if (replyMsg) {
            return await replyMsg.edit(payload);
          } else {
            replyMsg = await message.channel.send(payload);
            return replyMsg;
          }
        },
        followUp: async (options: any) => {
          const payload = typeof options === 'string' ? { content: options } : options;
          return await message.channel.send(payload);
        },
        options: {
          getString: (name: string) => {
            if (name === 'song' || name === 'query' || name === 'input' || name === 'file' || name === 'folder') {
              return query || null;
            }
            return null;
          },
          getInteger: () => null,
          getBoolean: () => null,
          getNumber: () => null,
          getUser: () => null,
          getChannel: () => null,
          getRole: () => null,
          getMentionable: () => null,
          getSubcommand: () => null,
          getSubcommandGroup: () => null,
        },
      };

      try {
        await handleChatInputCommand(
          textInteraction as any,
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
      } catch (err: any) {
        logger.error({ err, guildId: message.guildId }, 'Failed to execute text play command');
        await message.channel.send(`❌ Playback failed: ${err.message}`).catch(() => {});
      }
      return;
    }

    if (isMenuTrigger) {
      try {
        const { embeds, components } = await buildQuickPlayMenu(message.guildId, {
          analyticsManager,
          playlistManager,
          trackManager,
          recManager,
          userId: message.author.id,
        });
        await message.channel.send({
          content: `👋 Calling Gakki MusicBot! Here are your quick playback & playlist options:`,
          embeds,
          components,
        });
      } catch (err) {
        logger.error({ err, guildId: message.guildId }, 'Failed to send quickplay menu on chat trigger');
      }
    } else if (isPanelTrigger) {
      try {
        await spawnControlPanelInChannel(message.channel, message.guildId, activeManager);
      } catch (err) {
        logger.error({ err, guildId: message.guildId }, 'Failed to spawn control panel on chat trigger');
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
