import { Router } from 'express';
import { getDiscordClient } from '../../discord';
import type { PlaybackManager } from '@gakki/core';

export function discordRoutes(playbackManager?: PlaybackManager): Router {
  const router = Router();

  /**
   * GET /api/discord/guilds
   * Returns list of servers the bot has joined, voice connection status, and invite URL.
   */
  router.get('/guilds', async (_req, res) => {
    const client = getDiscordClient();
    const clientId = client?.user?.id || process.env.DISCORD_CLIENT_ID || '1553312697742004304';
    const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=8&scope=bot%20applications.commands`;

    if (!client || !client.isReady()) {
      res.json({
        connected: false,
        guildCount: 0,
        guilds: [],
        inviteUrl,
      });
      return;
    }

    const guilds = Array.from(client.guilds.cache.values()).map((guild) => {
      const me = guild.members.me;
      const botVoice = me?.voice;
      const voiceStatus = playbackManager ? playbackManager.getState(guild.id).voiceState : (botVoice?.channelId ? 'CONNECTED' : 'DISCONNECTED');
      const playerStatus = playbackManager ? playbackManager.getPlaybackStatus(guild.id) : 'IDLE';
      const currentTrack = playbackManager ? playbackManager.getCurrentTrack(guild.id) : null;

      return {
        id: guild.id,
        name: guild.name,
        icon: guild.iconURL() || null,
        memberCount: guild.memberCount,
        botInVoice: Boolean(botVoice?.channelId),
        voiceChannelId: botVoice?.channelId || null,
        voiceChannelName: botVoice?.channel?.name || null,
        voiceState: voiceStatus,
        playerState: playerStatus,
        currentTrack: currentTrack?.name || null,
      };
    });

    res.json({
      connected: true,
      botUser: {
        id: client.user.id,
        tag: client.user.tag,
        avatar: client.user.displayAvatarURL(),
      },
      guildCount: guilds.length,
      inviteUrl,
      guilds,
    });
  });

  /**
   * GET /api/discord/invite
   * Returns the OAuth2 bot invite URL.
   */
  router.get('/invite', (_req, res) => {
    const client = getDiscordClient();
    const clientId = client?.user?.id || process.env.DISCORD_CLIENT_ID || '1553312697742004304';
    const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=8&scope=bot%20applications.commands`;
    const audioPermsInviteUrl = `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=3147776&scope=bot%20applications.commands`;

    res.json({
      inviteUrl,
      audioPermsInviteUrl,
      clientId,
    });
  });

  return router;
}
