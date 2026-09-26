import {
  loadConfig,
  createLogger,
  connectDatabase,
  disconnectDatabase,
  QueueManager,
  PlaybackManager,
} from '@gakki/core';
import { createApiServer } from './api/server';
import { createDiscordBot, DiscordVoiceAdapter } from './discord';
import { createWebSocketServer } from './websocket';

const logger = createLogger('main');

async function main(): Promise<void> {
  logger.info('Starting Gakki Music Platform — Phase 4 (Voice Lifecycle, Audio Effects & Queue Manipulation)...');

  // ── Configuration ──────────────────────────────────────────────
  const config = loadConfig();
  logger.info({ env: config.NODE_ENV, port: config.API_PORT, voiceTimeout: config.VOICE_IDLE_TIMEOUT_SECONDS }, 'Configuration loaded');

  // ── Queue & Playback Engines ────────────────────────────────────
  const queueLogger = createLogger('queue-manager');
  const queueManager = new QueueManager(queueLogger);

  const playbackLogger = createLogger('playback-manager');
  const playbackManager = new PlaybackManager(
    playbackLogger,
    queueManager,
    config.VOICE_IDLE_TIMEOUT_SECONDS,
  );

  // ── Database ───────────────────────────────────────────────────
  let dbConnected = false;
  try {
    await connectDatabase(config.DATABASE_URL);
    dbConnected = true;
  } catch (error) {
    logger.error({ err: error }, 'Failed to connect to database — continuing without database');
  }

  // ── API Server ─────────────────────────────────────────────────
  const { server } = createApiServer(config.API_PORT, playbackManager);

  // ── WebSocket ──────────────────────────────────────────────────
  createWebSocketServer(server, playbackManager);

  // ── Discord Bot & Voice Adapter ────────────────────────────────
  let discordConnected = false;
  if (config.DISCORD_TOKEN) {
    try {
      const client = await createDiscordBot(config.DISCORD_TOKEN, playbackManager);
      const voiceAdapter = new DiscordVoiceAdapter(client);
      playbackManager.registerAdapter(voiceAdapter);
      discordConnected = true;
    } catch (error) {
      logger.error({ err: error }, 'Failed to start Discord bot — continuing without Discord');
    }
  } else {
    logger.warn('DISCORD_TOKEN not set — Discord bot will not start');
  }

  // ── Startup Summary ───────────────────────────────────────────
  logger.info(
    {
      database: dbConnected ? 'connected' : 'disconnected',
      discord: discordConnected ? 'connected' : 'disconnected',
      api: `http://localhost:${config.API_PORT}`,
      ws: `ws://localhost:${config.API_PORT}/ws`,
    },
    'Gakki Phase 4 startup complete',
  );

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
