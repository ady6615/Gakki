import { Client, GatewayIntentBits } from 'discord.js';
import { createLogger } from '@gakki/core';

const logger = createLogger('discord');

let client: Client | null = null;

/**
 * Create and connect the Discord bot client.
 *
 * Registers only the minimal intents needed:
 * - Guilds: required for guild membership
 * - GuildVoiceStates: required for voice channel operations
 *
 * Additional intents (e.g., MessageContent) should be added only
 * when specific features require them.
 *
 * @param token - Discord bot token
 * @returns The connected Discord.js Client
 * @throws If login fails (invalid token, network error, etc.)
 */
export async function createDiscordBot(token: string): Promise<Client> {
  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
    ],
  });

  client.once('ready', (readyClient) => {
    logger.info(
      { tag: readyClient.user.tag, guilds: readyClient.guilds.cache.size },
      'Discord bot ready',
    );
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
