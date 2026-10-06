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
  formatDuration,
} from './commands';
import {
  handleControlPanelButton,
  handleControlPanelSelectMenu,
  handleControlPanelModal,
  spawnControlPanelInChannel,
  refreshPanel,
} from './control-panel';
import { handleQuickPlayInteraction } from './quickplay-menu';
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
      for (const guild of readyClient.guilds.cache.values()) {
        try {
          await guild.commands.set(slashCommandDefinitions);
          logger.info({ guildId: guild.id, name: guild.name }, 'Registered slash commands to guild immediately');
        } catch (guildErr) {
          logger.warn({ guildId: guild.id, err: guildErr }, 'Could not set guild slash commands directly');
        }
      }
    } catch (cmdErr) {
      logger.error({ err: cmdErr }, 'Failed to register global slash commands');
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
      } else if (interaction.isModalSubmit() && interaction.customId === 'gakki:play_modal') {
        // Handle the play modal from the control panel
        const input = await handleControlPanelModal(interaction);
        if (input && interaction.guildId) {
          await interaction.deferReply();

          const guildId = interaction.guildId;
          const guild = interaction.guild ?? (await interaction.client.guilds.fetch(guildId).catch(() => null));
          let member = interaction.member as import('discord.js').GuildMember;
          if ((!member || !member.voice) && guild) {
            member = (await guild.members.fetch(interaction.user.id).catch(() => member)) as any;
          }

          const userVoiceChannel = member?.voice?.channel;

          // Auto-join voice if not connected
          const currentState = activeManager.getState(guildId);
          if (currentState.voiceState !== 'CONNECTED') {
            if (!userVoiceChannel) {
              await interaction.editReply('You must be in a voice channel to play music.');
              return;
            }
            try {
              await activeManager.join(guildId, userVoiceChannel.id);
            } catch (error) {
              await interaction.editReply(`Failed to join voice channel: ${(error as Error).message}`);
              return;
            }
          }

          // Resolve the input and play it
          try {
            const srcManager = audioSourceManager || createConfiguredAudioSourceManager();
            const resolved = await resolveAnyAudioInput(input, srcManager, trackManager);

            let source;
            if (resolved.path.startsWith('http://') || resolved.path.startsWith('https://')) {
              const { HttpAudioSource } = await import('@gakki/core');
              source = new HttpAudioSource(resolved.path, {
                title: resolved.name,
                artist: resolved.artist ?? null,
                album: resolved.album ?? null,
                duration: resolved.duration ?? null,
              });
            } else {
              const { LocalAudioSource } = await import('@gakki/core');
              source = new LocalAudioSource(resolved.path, undefined, probeAudioMetadata);
            }

            const playResult = await activeManager.play(guildId, source, {
              name: resolved.name,
              path: resolved.path,
              duration: resolved.duration ?? undefined,
              artist: resolved.artist,
              album: resolved.album,
              thumbnailUrl: resolved.thumbnailUrl,
              sourceProvider: resolved.sourceProvider || 'Local Library',
              sourceUrl: input,
              addedBy: member?.displayName || interaction.user.username,
              userId: interaction.user.id,
            });

            const durationStr = formatDuration(resolved.duration);
            if (playResult.status === 'started') {
              await interaction.editReply(
                `▶️ Now playing: **${resolved.name}**${resolved.artist ? ` by **${resolved.artist}**` : ''} \`[${durationStr}]\``,
              );
            } else {
              await interaction.editReply(
                `➕ Added to queue at position **#${playResult.position}**: **${resolved.name}** \`[${durationStr}]\``,
              );
            }
            await refreshPanel(guildId, activeManager).catch(() => {});
          } catch (err: any) {
            await interaction.editReply(`❌ Could not play: ${err.message}`);
          }
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

  // Listen for text triggers: bot mention (@Gakki), !panel, !gakki
  client.on('messageCreate', async (message) => {
    if (!activeManager || message.author.bot || !message.guildId) return;

    const botId = client?.user?.id;
    const isMentioned = botId && message.mentions.users.has(botId);
    const content = message.content.trim().toLowerCase();
    const isTriggerWord = content === '!panel' || content === '!gakki' || content === '!control' || content === '!player';

    if (isMentioned || isTriggerWord) {
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
