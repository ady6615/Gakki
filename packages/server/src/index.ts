import { loadConfig, createLogger, connectDatabase, disconnectDatabase } from '@gakki/core';
import { createApiServer } from './api/server';
import { createDiscordBot } from './discord/bot';
import { createWebSocketServer } from './websocket';

const logger = createLogger('main');

async function main(): Promise<void> {
  logger.info('Starting Gakki Music Platform...');

  // ── Configuration ──────────────────────────────────────────────
  const config = loadConfig();
  logger.info({ env: config.NODE_ENV, port: config.API_PORT }, 'Configuration loaded');

  // ── Database ───────────────────────────────────────────────────
  let dbConnected = false;
  try {
    await connectDatabase(config.DATABASE_URL);
    dbConnected = true;
  } catch (error) {
    logger.error({ err: error }, 'Failed to connect to database — continuing without database');
  }

  // ── API Server ─────────────────────────────────────────────────
  const { server } = createApiServer(config.API_PORT);

  // ── WebSocket ──────────────────────────────────────────────────
  createWebSocketServer(server);

  // ── Discord Bot ────────────────────────────────────────────────
  let discordConnected = false;
  if (config.DISCORD_TOKEN) {
    try {
      await createDiscordBot(config.DISCORD_TOKEN);
      discordConnected = true;
    } catch (error) {
      logger.error({ err: error }, 'Failed to start Discord bot — continuing without Discord');
    }
  } else {
    logger.warn('DISCORD_TOKEN not set — Discord bot will not start');
  }

  // ── Startup Summary ───────────────────────────────────────────
  logger.info({
    database: dbConnected ? 'connected' : 'disconnected',
    discord: discordConnected ? 'connected' : 'disconnected',
    api: `http://localhost:${config.API_PORT}`,
    ws: `ws://localhost:${config.API_PORT}/ws`,
  }, 'Gakki startup complete');

  // ── Graceful Shutdown ─────────────────────────────────────────
  const shutdown = async (): Promise<void> => {
    logger.info('Shutting down...');
    server.close();
    await disconnectDatabase();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('Fatal error during startup:', error);
  process.exit(1);
});
