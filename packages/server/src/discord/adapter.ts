import type { PlatformAdapter, PlatformConnectionState } from '@gakki/core';
import { createLogger } from '@gakki/core';
import { getDiscordClient } from './bot';

const logger = createLogger('discord-adapter');

/**
 * Discord platform adapter.
 *
 * Bridges the Discord.js client with the Gakki core engine
 * through the PlatformAdapter interface. This ensures the core
 * engine never directly imports or depends on discord.js.
 *
 * Phase 1: Connection status reporting only. Voice channel
 * operations (join, leave, play audio) will be added when the
 * playback pipeline is implemented in Phase 2.
 */
export class DiscordAdapter implements PlatformAdapter {
  readonly platform = 'discord' as const;

  get state(): PlatformConnectionState {
    const client = getDiscordClient();
    if (!client) return 'disconnected';
    return client.isReady() ? 'connected' : 'connecting';
  }

  async connect(): Promise<void> {
    // Connection is managed by createDiscordBot() in bot.ts.
    // This adapter wraps an already-connected client.
    logger.warn('DiscordAdapter.connect() is a no-op. Use createDiscordBot() to connect.');
  }

  async disconnect(): Promise<void> {
    const client = getDiscordClient();
    if (client) {
      client.destroy();
      logger.info('Discord client disconnected via adapter');
    }
  }

  isConnected(): boolean {
    return this.state === 'connected';
  }
}
