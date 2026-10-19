import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
  type ChatInputCommandInteraction,
  type Message,
  type TextBasedChannel,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ModalSubmitInteraction,
} from 'discord.js';
import type {
  PlaybackManager,
  LoopMode,
} from '@gakki/core';
import { createLogger } from '@gakki/core';
import { formatDuration } from './commands';

const logger = createLogger('control-panel');

// ─── Per-Guild Panel State ───────────────────────────────────────────────────

interface PanelState {
  message: Message | null;
  channelId: string;
  guildId: string;
  refreshInterval: NodeJS.Timeout | null;
}

const activePanels = new Map<string, PanelState>();

// ─── Constants ───────────────────────────────────────────────────────────────

const PANEL_REFRESH_MS = 6_000; // Auto-refresh elapsed time every 6s

const PLAYING_COLOR = 0x10b981;     // Emerald green
const PAUSED_COLOR = 0xf59e0b;      // Amber orange
const IDLE_COLOR = 0x6b7280;        // Slate gray

// ─── Emoji Constants ─────────────────────────────────────────────────────────

const EMOJI = {
  PLAY: '▶️',
  PAUSE: '⏸️',
  STOP: '⏹️',
  SKIP: '⏭️',
  PREV: '⏮️',
  SHUFFLE: '🔀',
  LOOP_OFF: '➡️',
  LOOP_TRACK: '🔂',
  LOOP_QUEUE: '🔁',
  VOLUME_MUTE: '🔇',
  VOLUME_LOW: '🔉',
  VOLUME_HIGH: '🔊',
  VOLUME_UP: '🔼',
  VOLUME_DOWN: '🔽',
  QUEUE: '📋',
  BASSBOOST: '🎚️',
  NIGHTCORE: '✨',
  SPEED: '⏩',
  DISCONNECT: '🚪',
  MUSIC: '🎵',
  ADD: '➕',
  PLAYNEXT: '⏩',
  CLEAR: '🧹',
} as const;

// ─── Progress Bar Helpers ────────────────────────────────────────────────────

function createProgressBar(current: number, total: number, length: number = 14): string {
  if (total <= 0) return '━'.repeat(length);
  const progress = Math.max(0, Math.min(current / total, 1));
  const filledLength = Math.round(progress * length);
  const before = '━'.repeat(Math.max(0, filledLength - 1));
  const head = '🔘';
  const after = '━'.repeat(Math.max(0, length - filledLength));
  return `${before}${head}${after}`;
}

function createVolumeBar(volume: number): string {
  const normalized = Math.min(Math.max(0, volume), 200);
  const bars = Math.round((normalized / 200) * 10);
  const filled = '█'.repeat(bars);
  const empty = '░'.repeat(10 - bars);
  return `${filled}${empty}`;
}

// ─── Build Embed ─────────────────────────────────────────────────────────────

function buildPanelEmbed(
  guildId: string,
  playbackManager: PlaybackManager,
): EmbedBuilder {
  const currentTrack = playbackManager.getCurrentTrack(guildId);
  const state = playbackManager.getState(guildId);
  const volume = playbackManager.getVolume(guildId);
  const filters = playbackManager.getFilters(guildId);
  const loopMode = playbackManager.getLoopMode(guildId);
  const queueItems = playbackManager.queueManager.getDisplayQueue(guildId);

  const isPlaying = state.playerState === 'PLAYING';
  const isPaused = state.playerState === 'PAUSED';

  const embed = new EmbedBuilder()
    .setColor(isPlaying ? PLAYING_COLOR : isPaused ? PAUSED_COLOR : IDLE_COLOR)
    .setFooter({
      text: `Gakki Control Panel  •  Volume: ${volume}%  •  Loop: ${loopMode.toUpperCase()}`,
    })
    .setTimestamp();

  if (currentTrack) {
    const duration = currentTrack.duration ?? 0;
    const durationStr = formatDuration(duration);
    const elapsedMs = playbackManager.getPlaybackDuration(guildId);
    const elapsedSec = Math.floor(elapsedMs / 1000);
    const elapsedStr = formatDuration(elapsedSec);

    const statusIcon = isPlaying ? EMOJI.PLAY : isPaused ? EMOJI.PAUSE : EMOJI.STOP;
    const statusLabel = isPlaying ? 'Now Playing' : isPaused ? 'Paused' : 'Stopped';

    embed.setTitle(`${EMOJI.MUSIC}  GAKKI CONTROL PANEL`);
    embed.setDescription(
      `### ${statusIcon}  ${statusLabel}\n` +
      `**${currentTrack.name}**\n` +
      (currentTrack.artist ? `*${currentTrack.artist}*\n` : '') +
      (currentTrack.album ? `Album: *${currentTrack.album}*\n` : '') +
      `\n` +
      `\`${elapsedStr}\`  ${createProgressBar(elapsedSec, duration)}  \`${durationStr}\`\n`,
    );

    if (currentTrack.thumbnailUrl && currentTrack.thumbnailUrl.startsWith('http')) {
      embed.setThumbnail(currentTrack.thumbnailUrl);
    }

    const volumeEmoji = volume === 0
      ? EMOJI.VOLUME_MUTE
      : volume < 100
        ? EMOJI.VOLUME_LOW
        : EMOJI.VOLUME_HIGH;

    embed.addFields(
      {
        name: `${volumeEmoji}  Volume — ${volume}%`,
        value: `\`${createVolumeBar(volume)}\``,
        inline: true,
      },
      {
        name: `${loopMode === 'off' ? EMOJI.LOOP_OFF : loopMode === 'track' ? EMOJI.LOOP_TRACK : EMOJI.LOOP_QUEUE}  Loop Mode`,
        value: `\`${loopMode === 'off' ? 'Disabled' : loopMode === 'track' ? 'Repeat Track' : 'Repeat Queue'}\``,
        inline: true,
      },
    );

    const activeFilters: string[] = [];
    if (filters.bassboost) activeFilters.push(`${EMOJI.BASSBOOST} Bass Boost`);
    if (filters.nightcore) activeFilters.push(`${EMOJI.NIGHTCORE} Nightcore`);
    if (filters.speed !== 1.0) activeFilters.push(`${EMOJI.SPEED} Speed ${filters.speed}x`);
    embed.addFields({
      name: '🎛️  Audio Effects',
      value: activeFilters.length > 0 ? activeFilters.join('  •  ') : '`None active (Flat)`',
      inline: false,
    });
  } else {
    embed.setTitle(`${EMOJI.MUSIC}  GAKKI CONTROL PANEL`);
    embed.setDescription(
      `### ${EMOJI.STOP}  Nothing Playing\n` +
      `Click **${EMOJI.ADD} Play Song** or type a query to start music!\n\n` +
      `${EMOJI.VOLUME_LOW} Volume: \`${createVolumeBar(volume)}\` **${volume}%**`,
    );
  }

  // Queue preview (first 5 tracks)
  if (queueItems.length > 0) {
    const preview = queueItems.slice(0, 5);
    const queueStr = preview
      .map((item) => {
        const dur = item.duration ? ` \`[${formatDuration(item.duration)}]\`` : '';
        const nextTag = item.playNext ? ' `[NEXT]`' : '';
        return `\`${item.position}.\`${nextTag} ${item.name}${dur}`;
      })
      .join('\n');

    const remaining = queueItems.length > 5
      ? `\n*...and ${queueItems.length - 5} more in queue*`
      : '';

    embed.addFields({
      name: `${EMOJI.QUEUE}  Up Next (${queueItems.length} track${queueItems.length === 1 ? '' : 's'})`,
      value: queueStr + remaining,
      inline: false,
    });
  }

  return embed;
}

// ─── Build Component Rows ────────────────────────────────────────────────────

function buildComponentRows(
  guildId: string,
  playbackManager: PlaybackManager,
): ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] {
  const state = playbackManager.getState(guildId);
  const filters = playbackManager.getFilters(guildId);
  const loopMode = playbackManager.getLoopMode(guildId);
  const volume = playbackManager.getVolume(guildId);

  const isPlaying = state.playerState === 'PLAYING';
  const isPaused = state.playerState === 'PAUSED';
  const hasTrack = !!playbackManager.getCurrentTrack(guildId);
  const queueLength = playbackManager.queueManager.getQueueLength(guildId);

  // ── Row 1: Primary Playback Controls ───────────────────────────────────
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('gakki:play_pause')
      .setEmoji(isPlaying ? EMOJI.PAUSE : EMOJI.PLAY)
      .setStyle(isPlaying ? ButtonStyle.Secondary : ButtonStyle.Success)
      .setDisabled(!hasTrack && !isPaused && queueLength === 0),
    new ButtonBuilder()
      .setCustomId('gakki:skip')
      .setEmoji(EMOJI.SKIP)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!hasTrack && queueLength === 0),
    new ButtonBuilder()
      .setCustomId('gakki:stop')
      .setEmoji(EMOJI.STOP)
      .setLabel('Stop')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!hasTrack && state.voiceState === 'DISCONNECTED'),
    new ButtonBuilder()
      .setCustomId('gakki:search')
      .setEmoji(EMOJI.ADD)
      .setLabel('Play')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('gakki:playnext')
      .setEmoji(EMOJI.PLAYNEXT)
      .setLabel('Play Next')
      .setStyle(ButtonStyle.Success),
  );

  // ── Row 2: Quick Jump Navigation & Seek Buttons ─────────────────────────
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('gakki:seek_back_30')
      .setLabel('−30s')
      .setEmoji('⏪')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasTrack),
    new ButtonBuilder()
      .setCustomId('gakki:seek_back_10')
      .setLabel('−10s')
      .setEmoji('◀️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasTrack),
    new ButtonBuilder()
      .setCustomId('gakki:seek_restart')
      .setLabel('0:00')
      .setEmoji('⏮️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasTrack),
    new ButtonBuilder()
      .setCustomId('gakki:seek_fwd_10')
      .setLabel('+10s')
      .setEmoji('▶️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasTrack),
    new ButtonBuilder()
      .setCustomId('gakki:seek_fwd_30')
      .setLabel('+30s')
      .setEmoji('⏩')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasTrack),
  );

  // ── Row 3: Interactive Song Navigation (Select Menu) ─────────────────────
  const currentTrack = playbackManager.getCurrentTrack(guildId);
  const elapsedMs = playbackManager.getPlaybackDuration(guildId);
  const elapsedSec = Math.floor(elapsedMs / 1000);
  const totalDuration = currentTrack?.duration ?? 0;

  const navPlaceholder = hasTrack
    ? `🧭 Song Navigation (${formatDuration(elapsedSec)} / ${formatDuration(totalDuration)})`
    : '🧭 Song Navigation (Play a song to navigate)';

  const navOptions = [
    {
      label: '⏪ −30s (Rewind 30 Seconds)',
      value: 'rel_-30',
      emoji: '⏪',
      description: 'Skip backward by 30 seconds',
    },
    {
      label: '◀️ −10s (Rewind 10 Seconds)',
      value: 'rel_-10',
      emoji: '◀️',
      description: 'Skip backward by 10 seconds',
    },
    {
      label: '▶️ +10s (Skip Ahead 10 Seconds)',
      value: 'rel_10',
      emoji: '▶️',
      description: 'Skip forward by 10 seconds',
    },
    {
      label: '⏩ +30s (Skip Ahead 30 Seconds)',
      value: 'rel_30',
      emoji: '⏩',
      description: 'Skip forward by 30 seconds',
    },
    {
      label: '⏭️ +60s (Skip Ahead 1 Minute)',
      value: 'rel_60',
      emoji: '⏭️',
      description: 'Skip forward by 60 seconds',
    },
    {
      label: '⏮️ Restart Song from Beginning',
      value: 'abs_0',
      emoji: '⏮️',
      description: 'Replay from the very beginning (0:00)',
    },
    {
      label: '¼ Jump to 25% (First Quarter)',
      value: 'pct_25',
      emoji: '⏱️',
      description: 'Jump to 25% through the song',
    },
    {
      label: '½ Jump to 50% (Halfway Point)',
      value: 'pct_50',
      emoji: '⏱️',
      description: 'Jump to midpoint of the song',
    },
    {
      label: '¾ Jump to 75% (Three-Quarter Mark)',
      value: 'pct_75',
      emoji: '⏱️',
      description: 'Jump to 75% through the song',
    },
  ];

  const row3 = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('gakki:nav_menu')
      .setPlaceholder(navPlaceholder.slice(0, 100))
      .setMinValues(1)
      .setMaxValues(1)
      .setDisabled(!hasTrack)
      .addOptions(navOptions),
  );

  // ── Row 4: Audio Effects, Speed & Volume Presets (Select Menu) ───────────
  const speedLabel = filters.speed !== 1.0 ? ` • Speed: ${filters.speed}x` : '';
  const bbLabel = filters.bassboost ? ' • BassBoost: ON' : '';
  const ncLabel = filters.nightcore ? ' • Nightcore: ON' : '';
  const effectsPlaceholder = `🎛️ Audio Effects, Speed & Volume (${volume}%)${bbLabel}${ncLabel}${speedLabel}`;

  const row4 = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('gakki:effects_slider')
      .setPlaceholder(effectsPlaceholder.slice(0, 100))
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(
        {
          label: 'Normal / Reset EQ',
          value: 'flat',
          emoji: '✨',
          description: 'Turn off all filters, reset speed to 1.0x',
        },
        {
          label: `Bass Boost: ${filters.bassboost ? 'ON (Click to disable)' : 'OFF (Click to enable)'}`,
          value: 'bassboost_toggle',
          emoji: '🎚️',
          description: 'Deep punchy bass boost',
        },
        {
          label: `Nightcore: ${filters.nightcore ? 'ON (Click to disable)' : 'OFF (Click to enable)'}`,
          value: 'nightcore_toggle',
          emoji: '⚡',
          description: 'Sped up high-pitch anime/nightcore vibe',
        },
        {
          label: '0.75x — Slowed & Relaxed',
          value: 'speed_0.75',
          emoji: '🌊',
          description: 'Chill, slowed vaporwave pace',
        },
        {
          label: '1.0x — Standard Speed',
          value: 'speed_1.0',
          emoji: '▶️',
          description: 'Normal audio speed',
        },
        {
          label: '1.25x — Upbeat Faster',
          value: 'speed_1.25',
          emoji: '🏃',
          description: '1.25x playback rate',
        },
        {
          label: '1.5x — Fast',
          value: 'speed_1.5',
          emoji: '🚀',
          description: '1.5x fast playback rate',
        },
        {
          label: '2.0x — Double Speed',
          value: 'speed_2.0',
          emoji: '🔥',
          description: '2x maximum playback rate',
        },
        {
          label: 'Volume: Mute (0%)',
          value: 'vol_0',
          emoji: '🔇',
          description: 'Completely silence audio',
        },
        {
          label: 'Volume: 50% (Half Volume)',
          value: 'vol_50',
          emoji: '🔉',
          description: 'Set audio output to 50%',
        },
        {
          label: 'Volume: 100% (Standard Volume)',
          value: 'vol_100',
          emoji: '🔊',
          description: 'Set standard 100% volume',
        },
        {
          label: 'Volume: 150% (Boosted)',
          value: 'vol_150',
          emoji: '🔊',
          description: 'Set boosted 150% volume',
        },
        {
          label: 'Volume: 200% (Maximum)',
          value: 'vol_200',
          emoji: '🔥',
          description: 'Set maximum 200% amplification',
        },
      ),
  );

  // ── Row 5: Queue & Management Buttons ────────────────────────────────────
  const loopLabels: Record<LoopMode, string> = {
    off: 'Loop: Off',
    track: 'Loop: Track',
    queue: 'Loop: Queue',
  };
  const loopEmojis: Record<LoopMode, string> = {
    off: EMOJI.LOOP_OFF,
    track: EMOJI.LOOP_TRACK,
    queue: EMOJI.LOOP_QUEUE,
  };

  const row5 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('gakki:shuffle')
      .setEmoji(EMOJI.SHUFFLE)
      .setLabel('Shuffle')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(queueLength < 2),
    new ButtonBuilder()
      .setCustomId('gakki:loop_cycle')
      .setEmoji(loopEmojis[loopMode])
      .setLabel(loopLabels[loopMode])
      .setStyle(loopMode !== 'off' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('gakki:view_queue')
      .setEmoji(EMOJI.QUEUE)
      .setLabel(`Queue (${queueLength})`)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('gakki:clear_queue')
      .setEmoji(EMOJI.CLEAR)
      .setLabel('Clear Queue')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(queueLength === 0),
    new ButtonBuilder()
      .setCustomId('gakki:disconnect')
      .setEmoji(EMOJI.DISCONNECT)
      .setLabel('Leave')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(state.voiceState === 'DISCONNECTED'),
  );

  return [row1, row2, row3, row4, row5];
}

// ─── Send / Update Panel ─────────────────────────────────────────────────────

/**
 * Spawn the control panel via a slash command interaction (/panel).
 */
export async function spawnControlPanel(
  interaction: ChatInputCommandInteraction,
  playbackManager: PlaybackManager,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'The control panel can only be used in a Discord server.', ephemeral: true });
    }
    return;
  }

  try {
    // Clean up existing panel in this guild
    const existing = activePanels.get(guildId);
    if (existing) {
      if (existing.refreshInterval) clearInterval(existing.refreshInterval);
      try {
        if (existing.message) {
          await existing.message.delete().catch(() => {});
        }
      } catch { /* ignore */ }
    }

    const embed = buildPanelEmbed(guildId, playbackManager);
    const components = buildComponentRows(guildId, playbackManager);

    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply();
    }

    const message = await interaction.editReply({
      embeds: [embed],
      components,
    });

    // Set up auto-refresh
    const refreshInterval = setInterval(async () => {
      try {
        const panel = activePanels.get(guildId);
        if (!panel || !panel.message) return;

        const freshEmbed = buildPanelEmbed(guildId, playbackManager);
        const freshComponents = buildComponentRows(guildId, playbackManager);

        await panel.message.edit({
          embeds: [freshEmbed],
          components: freshComponents,
        });
      } catch (err: any) {
        if (err.code === 10008) {
          const panel = activePanels.get(guildId);
          if (panel?.refreshInterval) clearInterval(panel.refreshInterval);
          activePanels.delete(guildId);
        }
      }
    }, PANEL_REFRESH_MS);
    refreshInterval.unref();

    activePanels.set(guildId, {
      message: message as Message,
      channelId: interaction.channelId,
      guildId,
      refreshInterval,
    });

    logger.info({ guildId, channelId: interaction.channelId }, 'Control panel spawned via slash command');
  } catch (err: any) {
    logger.error({ err, guildId }, 'Error spawning control panel');
    const errMsg = `❌ Failed to spawn control panel: ${err.message}`;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: errMsg, embeds: [], components: [] }).catch(() => {});
    } else {
      await interaction.reply({ content: errMsg, ephemeral: true }).catch(() => {});
    }
  }
}

/**
 * Spawn the control panel into any text channel (e.g. on bot mention, join, play, etc.)
 */
export async function spawnControlPanelInChannel(
  channel: any,
  guildId: string,
  playbackManager: PlaybackManager,
): Promise<Message | null> {
  // Clean up existing panel in this guild
  const existing = activePanels.get(guildId);
  if (existing) {
    if (existing.refreshInterval) clearInterval(existing.refreshInterval);
    try {
      if (existing.message) {
        await existing.message.delete().catch(() => {});
      }
    } catch { /* ignore */ }
  }

  const embed = buildPanelEmbed(guildId, playbackManager);
  const components = buildComponentRows(guildId, playbackManager);

  try {
    const message = await channel.send({
      embeds: [embed],
      components,
    });

    const refreshInterval = setInterval(async () => {
      try {
        const panel = activePanels.get(guildId);
        if (!panel || !panel.message) return;

        const freshEmbed = buildPanelEmbed(guildId, playbackManager);
        const freshComponents = buildComponentRows(guildId, playbackManager);

        await panel.message.edit({
          embeds: [freshEmbed],
          components: freshComponents,
        });
      } catch (err: any) {
        if (err.code === 10008) {
          const panel = activePanels.get(guildId);
          if (panel?.refreshInterval) clearInterval(panel.refreshInterval);
          activePanels.delete(guildId);
        }
      }
    }, PANEL_REFRESH_MS);
    refreshInterval.unref();

    activePanels.set(guildId, {
      message,
      channelId: channel.id,
      guildId,
      refreshInterval,
    });

    logger.info({ guildId, channelId: channel.id }, 'Control panel spawned in channel');
    return message;
  } catch (err) {
    logger.error({ err, guildId, channelId: channel.id }, 'Failed to spawn control panel in channel');
    return null;
  }
}

/**
 * Refresh the panel embed and components after any state or playback change.
 */
export async function refreshPanel(
  guildId: string,
  playbackManager: PlaybackManager,
): Promise<void> {
  const panel = activePanels.get(guildId);
  if (!panel || !panel.message) return;

  try {
    const embed = buildPanelEmbed(guildId, playbackManager);
    const components = buildComponentRows(guildId, playbackManager);
    await panel.message.edit({ embeds: [embed], components });
  } catch (err: any) {
    if (err.code === 10008) {
      if (panel.refreshInterval) clearInterval(panel.refreshInterval);
      activePanels.delete(guildId);
    }
  }
}

// ─── Button Interaction Handler ──────────────────────────────────────────────

/**
 * Handle all button clicks from the control panel.
 */
export async function handleControlPanelButton(
  interaction: ButtonInteraction,
  playbackManager: PlaybackManager,
): Promise<void> {
  const guildId = interaction.guildId!;
  const customId = interaction.customId;

  if (!customId.startsWith('gakki:')) return;

  try {
    switch (customId) {
      // ── Previous / Replay ──────────────────────────────────────────
      case 'gakki:prev': {
        const elapsed = playbackManager.getPlaybackDuration(guildId);
        if (elapsed > 4000) {
          // Restart current track by advancing or loop
          const currentTrack = playbackManager.getCurrentTrack(guildId);
          if (currentTrack) {
            playbackManager.setLoopMode(guildId, 'track');
            await playbackManager.skip(guildId);
            playbackManager.setLoopMode(guildId, 'off');
            await interaction.reply({ content: `${EMOJI.PREV} Replaying **${currentTrack.name}**`, ephemeral: true });
          }
        } else {
          await interaction.reply({ content: `${EMOJI.PREV} Already at start of track.`, ephemeral: true });
        }
        break;
      }

      // ── Play/Pause Toggle ──────────────────────────────────────────
      case 'gakki:play_pause': {
        const state = playbackManager.getState(guildId);
        if (state.playerState === 'PLAYING') {
          playbackManager.pause(guildId);
          await interaction.reply({ content: `${EMOJI.PAUSE} Playback paused.`, ephemeral: true });
        } else if (state.playerState === 'PAUSED') {
          playbackManager.resume(guildId);
          await interaction.reply({ content: `${EMOJI.PLAY} Playback resumed.`, ephemeral: true });
        } else {
          const queueLen = playbackManager.queueManager.getQueueLength(guildId);
          if (queueLen > 0) {
            await playbackManager.advanceQueue(guildId);
            await interaction.reply({ content: `${EMOJI.PLAY} Started playback from queue.`, ephemeral: true });
          } else {
            await interaction.reply({ content: `Nothing in queue. Click **Play Song** to add music!`, ephemeral: true });
          }
        }
        break;
      }

      // ── Skip ───────────────────────────────────────────────────────
      case 'gakki:skip': {
        const result = await playbackManager.skip(guildId);
        if (result.skipped) {
          if (result.nowPlaying) {
            await interaction.reply({
              content: `${EMOJI.SKIP} Skipped! Now playing: **${result.nowPlaying.name}**`,
              ephemeral: true,
            });
          } else {
            await interaction.reply({ content: `${EMOJI.SKIP} Skipped. Queue is now empty.`, ephemeral: true });
          }
        } else {
          await interaction.reply({ content: 'Nothing to skip.', ephemeral: true });
        }
        break;
      }

      // ── Stop ───────────────────────────────────────────────────────
      case 'gakki:stop': {
        playbackManager.stop(guildId);
        await interaction.reply({ content: `${EMOJI.STOP} Playback stopped.`, ephemeral: true });
        break;
      }

      // ── Search / Add Song Modal ────────────────────────────────────
      case 'gakki:search': {
        const modal = new ModalBuilder()
          .setCustomId('gakki:play_modal')
          .setTitle('🎵 Play Song or Audio URL');

        const inputField = new TextInputBuilder()
          .setCustomId('gakki:play_input')
          .setLabel('Song title, artist, URL, or local file')
          .setPlaceholder('e.g. Faded Alan Walker, https://soundcloud.com/..., track.mp3')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(300);

        modal.addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(inputField),
        );

        await interaction.showModal(modal);
        return;
      }

      // ── Play Next Modal ───────────────────────────────────────────
      case 'gakki:playnext': {
        const modal = new ModalBuilder()
          .setCustomId('gakki:playnext_modal')
          .setTitle('⏩ Play Next (Top of Queue)');

        const inputField = new TextInputBuilder()
          .setCustomId('gakki:playnext_input')
          .setLabel('Song title, artist, URL, or local file')
          .setPlaceholder('Song to play right after current track')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(300);

        modal.addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(inputField),
        );

        await interaction.showModal(modal);
        return;
      }

      // ── Quick Jump Navigation Buttons ──────────────────────────────
      case 'gakki:seek_back_30': {
        const newPos = await playbackManager.seek(guildId, -30, true);
        if (newPos !== null) {
          await interaction.reply({
            content: `⏪ Rewound 30s to **${formatDuration(newPos)}**`,
            ephemeral: true,
          });
        } else {
          await interaction.reply({ content: 'No track currently playing.', ephemeral: true });
        }
        break;
      }
      case 'gakki:seek_back_10': {
        const newPos = await playbackManager.seek(guildId, -10, true);
        if (newPos !== null) {
          await interaction.reply({
            content: `◀️ Rewound 10s to **${formatDuration(newPos)}**`,
            ephemeral: true,
          });
        } else {
          await interaction.reply({ content: 'No track currently playing.', ephemeral: true });
        }
        break;
      }
      case 'gakki:seek_restart': {
        const newPos = await playbackManager.seek(guildId, 0, false);
        if (newPos !== null) {
          await interaction.reply({
            content: `🔄 Restarted track from beginning (\`0:00\`)`,
            ephemeral: true,
          });
        } else {
          await interaction.reply({ content: 'No track currently playing.', ephemeral: true });
        }
        break;
      }
      case 'gakki:seek_fwd_10': {
        const newPos = await playbackManager.seek(guildId, 10, true);
        if (newPos !== null) {
          await interaction.reply({
            content: `▶️ Skipped ahead 10s to **${formatDuration(newPos)}**`,
            ephemeral: true,
          });
        } else {
          await interaction.reply({ content: 'No track currently playing.', ephemeral: true });
        }
        break;
      }
      case 'gakki:seek_fwd_30': {
        const newPos = await playbackManager.seek(guildId, 30, true);
        if (newPos !== null) {
          await interaction.reply({
            content: `⏩ Skipped ahead 30s to **${formatDuration(newPos)}**`,
            ephemeral: true,
          });
        } else {
          await interaction.reply({ content: 'No track currently playing.', ephemeral: true });
        }
        break;
      }

      // ── Volume Step Buttons ────────────────────────────────────────
      case 'gakki:vol_down_25': {
        const currentVol = playbackManager.getVolume(guildId);
        const newVol = playbackManager.setVolume(guildId, Math.max(0, currentVol - 25));
        await interaction.reply({ content: `${EMOJI.VOLUME_DOWN} Volume set to **${newVol}%**`, ephemeral: true });
        break;
      }
      case 'gakki:vol_down_10': {
        const currentVol = playbackManager.getVolume(guildId);
        const newVol = playbackManager.setVolume(guildId, Math.max(0, currentVol - 10));
        await interaction.reply({ content: `${EMOJI.VOLUME_DOWN} Volume set to **${newVol}%**`, ephemeral: true });
        break;
      }
      case 'gakki:vol_mute': {
        const currentVol = playbackManager.getVolume(guildId);
        if (currentVol === 0) {
          playbackManager.setVolume(guildId, 100);
          await interaction.reply({ content: `${EMOJI.VOLUME_HIGH} Unmuted! Volume restored to **100%**`, ephemeral: true });
        } else {
          playbackManager.setVolume(guildId, 0);
          await interaction.reply({ content: `${EMOJI.VOLUME_MUTE} Audio muted (0%).`, ephemeral: true });
        }
        break;
      }
      case 'gakki:vol_up_10': {
        const currentVol = playbackManager.getVolume(guildId);
        const newVol = playbackManager.setVolume(guildId, Math.min(200, currentVol + 10));
        await interaction.reply({ content: `${EMOJI.VOLUME_UP} Volume set to **${newVol}%**`, ephemeral: true });
        break;
      }
      case 'gakki:vol_up_25': {
        const currentVol = playbackManager.getVolume(guildId);
        const newVol = playbackManager.setVolume(guildId, Math.min(200, currentVol + 25));
        await interaction.reply({ content: `${EMOJI.VOLUME_UP} Volume set to **${newVol}%**`, ephemeral: true });
        break;
      }

      // ── Shuffle ────────────────────────────────────────────────────
      case 'gakki:shuffle': {
        const count = playbackManager.queueManager.getQueueLength(guildId);
        if (count >= 2) {
          playbackManager.shuffleQueue(guildId);
          await interaction.reply({ content: `${EMOJI.SHUFFLE} Shuffled **${count}** tracks in the queue.`, ephemeral: true });
        } else {
          await interaction.reply({ content: 'Need at least 2 tracks in the queue to shuffle.', ephemeral: true });
        }
        break;
      }

      // ── Loop Cycle ─────────────────────────────────────────────────
      case 'gakki:loop_cycle': {
        const current = playbackManager.getLoopMode(guildId);
        const next: LoopMode = current === 'off' ? 'track' : current === 'track' ? 'queue' : 'off';
        playbackManager.setLoopMode(guildId, next);

        const labels: Record<LoopMode, string> = {
          off: 'Disabled',
          track: 'Repeat Track (🔂)',
          queue: 'Repeat Entire Queue (🔁)',
        };
        await interaction.reply({
          content: `Loop mode changed to: **${labels[next]}**`,
          ephemeral: true,
        });
        break;
      }

      // ── View Queue ─────────────────────────────────────────────────
      case 'gakki:view_queue': {
        const items = playbackManager.queueManager.getDisplayQueue(guildId);
        if (items.length === 0) {
          await interaction.reply({ content: '📋 The queue is currently empty.', ephemeral: true });
          return;
        }

        const totalSecs = items.reduce((acc, it) => acc + (it.duration || 0), 0);
        const preview = items.slice(0, 15);
        const listStr = preview
          .map((item) => `\`${item.position}.\` **${item.name}** \`[${formatDuration(item.duration)}]\``)
          .join('\n');

        const remainingCount = items.length > 15 ? `\n*...plus ${items.length - 15} more*` : '';

        const queueEmbed = new EmbedBuilder()
          .setTitle(`📋 Current Playback Queue (${items.length} tracks)`)
          .setColor(0x7c3aed)
          .setDescription(`${listStr}${remainingCount}\n\n**Total Estimated Time:** \`${formatDuration(totalSecs)}\``)
          .setFooter({ text: 'Use the control panel buttons to control playback.' });

        const queueActionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId('gakki:clear_queue')
            .setEmoji(EMOJI.CLEAR)
            .setLabel('Clear Queue')
            .setStyle(ButtonStyle.Danger),
        );

        await interaction.reply({ embeds: [queueEmbed], components: [queueActionRow], ephemeral: true });
        return;
      }

      // ── Clear Queue ────────────────────────────────────────────────
      case 'gakki:clear_queue': {
        const count = playbackManager.queueManager.getQueueLength(guildId);
        playbackManager.clearQueue(guildId);
        await interaction.reply({ content: `${EMOJI.CLEAR} Cleared **${count}** tracks from the queue.`, ephemeral: true });
        break;
      }

      // ── Disconnect ─────────────────────────────────────────────────
      case 'gakki:disconnect': {
        await playbackManager.leave(guildId);
        await interaction.reply({ content: `${EMOJI.DISCONNECT} Left the voice channel.`, ephemeral: true });
        break;
      }

      default:
        await interaction.reply({ content: 'Unknown control action.', ephemeral: true });
        return;
    }
  } catch (err: any) {
    logger.error({ err, customId, guildId }, 'Error handling control panel button');
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(`❌ Error: ${err.message}`).catch(() => {});
    } else {
      await interaction.reply({ content: `❌ Error: ${err.message}`, ephemeral: true }).catch(() => {});
    }
  }

  // Refresh the control panel after every action
  await refreshPanel(guildId, playbackManager);
}

// ─── Select Menu Interaction Handler ─────────────────────────────────────────

/**
 * Handle all select menu interactions from the control panel.
 */
export async function handleControlPanelSelectMenu(
  interaction: StringSelectMenuInteraction,
  playbackManager: PlaybackManager,
): Promise<void> {
  const guildId = interaction.guildId!;
  const customId = interaction.customId;

  if (!customId.startsWith('gakki:')) return;

  try {
    switch (customId) {
      // ── Interactive Volume Slider ──────────────────────────────────
      case 'gakki:vol_slider': {
        const selectedVol = parseInt(interaction.values[0], 10);
        playbackManager.setVolume(guildId, selectedVol);

        await interaction.reply({
          content: `🎚️ Volume slider adjusted to **${selectedVol}%** \`${createVolumeBar(selectedVol)}\``,
          ephemeral: true,
        });
        break;
      }

      // ── Audio Effects & Speed Slider ───────────────────────────────
      case 'gakki:effects_slider': {
        const selected = interaction.values[0];

        if (selected === 'flat') {
          await playbackManager.setSpeed(guildId, 1.0);
          await playbackManager.setBassboost(guildId, false);
          await playbackManager.setNightcore(guildId, false);
          await interaction.reply({ content: '✨ Audio effects reset to **Normal / Flat** (Speed 1.0x).', ephemeral: true });
        } else if (selected === 'bassboost_toggle') {
          const currentFilters = playbackManager.getFilters(guildId);
          const newState = !currentFilters.bassboost;
          await playbackManager.setBassboost(guildId, newState);
          await interaction.reply({ content: `🎚️ Bass Boost turned **${newState ? 'ON' : 'OFF'}**`, ephemeral: true });
        } else if (selected === 'nightcore_toggle') {
          const currentFilters = playbackManager.getFilters(guildId);
          const newState = !currentFilters.nightcore;
          await playbackManager.setNightcore(guildId, newState);
          await interaction.reply({ content: `⚡ Nightcore mode turned **${newState ? 'ON' : 'OFF'}**`, ephemeral: true });
        } else if (selected.startsWith('speed_')) {
          const speedVal = parseFloat(selected.replace('speed_', ''));
          await playbackManager.setSpeed(guildId, speedVal);
          await interaction.reply({ content: `⏩ Playback speed set to **${speedVal}x**`, ephemeral: true });
        } else if (selected.startsWith('vol_')) {
          const volVal = parseInt(selected.replace('vol_', ''), 10);
          playbackManager.setVolume(guildId, volVal);
          await interaction.reply({
            content: `🎚️ Volume set to **${volVal}%** \`${createVolumeBar(volVal)}\``,
            ephemeral: true,
          });
        }
        break;
      }

      // ── Song Navigation Setting (Select Menu) ──────────────────────
      case 'gakki:nav_menu': {
        const selected = interaction.values[0];
        const track = playbackManager.getCurrentTrack(guildId);
        if (!track) {
          await interaction.reply({ content: 'No track currently playing.', ephemeral: true });
          break;
        }

        let newPos: number | null = null;
        let desc = '';

        if (selected.startsWith('rel_')) {
          const delta = parseInt(selected.replace('rel_', ''), 10);
          newPos = await playbackManager.seek(guildId, delta, true);
          desc = delta > 0 ? `skipped ahead **+${delta}s**` : `rewound **${delta}s**`;
        } else if (selected === 'abs_0') {
          newPos = await playbackManager.seek(guildId, 0, false);
          desc = 'restarted from start (**0:00**)';
        } else if (selected.startsWith('pct_')) {
          const pct = parseInt(selected.replace('pct_', ''), 10);
          const duration = track.duration || 0;
          const target = Math.floor((duration * pct) / 100);
          newPos = await playbackManager.seek(guildId, target, false);
          desc = `jumped to **${pct}%** (${formatDuration(target)})`;
        }

        if (newPos !== null) {
          await interaction.reply({
            content: `🧭 **Song Navigation:** Successfully ${desc} → Position: **${formatDuration(newPos)}** / **${formatDuration(track.duration)}**`,
            ephemeral: true,
          });
        } else {
          await interaction.reply({ content: 'Could not navigate current track.', ephemeral: true });
        }
        break;
      }

      default:
        await interaction.reply({ content: 'Unknown selection menu.', ephemeral: true });
        return;
    }
  } catch (err: any) {
    logger.error({ err, customId, guildId }, 'Error handling control panel select menu');
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(`❌ Error: ${err.message}`).catch(() => {});
    } else {
      await interaction.reply({ content: `❌ Error: ${err.message}`, ephemeral: true }).catch(() => {});
    }
  }

  await refreshPanel(guildId, playbackManager);
}

// ─── Modal Submit Handler ────────────────────────────────────────────────────

/**
 * Handle the play modal form submission.
 */
export async function handleControlPanelModal(
  interaction: ModalSubmitInteraction,
): Promise<string | null> {
  if (interaction.customId !== 'gakki:play_modal' && interaction.customId !== 'gakki:playnext_modal') return null;

  const fieldId = interaction.customId === 'gakki:playnext_modal' ? 'gakki:playnext_input' : 'gakki:play_input';
  const input = interaction.fields.getTextInputValue(fieldId)?.trim();
  if (!input) {
    await interaction.reply({ content: 'Please provide a song name, URL, or local file.', ephemeral: true });
    return null;
  }

  return input;
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

/**
 * Destroy the control panel for a guild (e.g. on disconnect or reset).
 */
export function destroyControlPanel(guildId: string): void {
  const panel = activePanels.get(guildId);
  if (!panel) return;

  if (panel.refreshInterval) clearInterval(panel.refreshInterval);
  if (panel.message) {
    panel.message.delete().catch(() => {});
  }
  activePanels.delete(guildId);
  logger.info({ guildId }, 'Control panel destroyed');
}

/**
 * Check if a guild has an active control panel.
 */
export function hasActivePanel(guildId: string): boolean {
  return activePanels.has(guildId);
}
