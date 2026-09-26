import {
  loadConfig,
  createLogger,
  connectDatabase,
  disconnectDatabase,
  type DatabaseClient,
  QueueManager,
  PlaybackManager,
  GuildSettingsManager,
  TrackManager,
  AnalyticsManager,
  PlaylistManager,
} from '@gakki/core';
import { createApiServer } from './api/server';
import { createDiscordBot, DiscordVoiceAdapter } from './discord';
import { createWebSocketServer } from './websocket';
import { ArtworkService } from './services/artwork.service';
import { createConfiguredAudioSourceManager } from './sources';

const logger = createLogger('main');

async function main(): Promise<void> {
  logger.info('Starting Gakki Music Platform — Phase 6 (Play History, Persistent Playlists & Session Analytics)...');

  // ── Configuration ──────────────────────────────────────────────
  const config = loadConfig();
  logger.info({ env: config.NODE_ENV, port: config.API_PORT, voiceTimeout: config.VOICE_IDLE_TIMEOUT_SECONDS }, 'Configuration loaded');

  // ── Database ───────────────────────────────────────────────────
  let dbClient: DatabaseClient | null = null;
  let dbConnected = false;
  try {
    dbClient = await connectDatabase(config.DATABASE_URL);
    dbConnected = true;
  } catch (error) {
    logger.error({ err: error }, 'Failed to connect to database — continuing without database');
  }

  // ── Persistent Metadata & Analytics Services ────────────────────
  const guildSettingsManager = new GuildSettingsManager(dbClient, {
    defaultIdleTimeoutSeconds: config.VOICE_IDLE_TIMEOUT_SECONDS,
  });
  const trackManager = new TrackManager(dbClient);
  const analyticsLogger = createLogger('analytics-manager');
  const analyticsManager = new AnalyticsManager(dbClient, analyticsLogger);
  const playlistLogger = createLogger('playlist-manager');
  const playlistManager = new PlaylistManager(dbClient, playlistLogger);

  const artworkService = new ArtworkService();
  const audioSourceManager = createConfiguredAudioSourceManager(artworkService, trackManager);

  // ── Queue & Playback Engines ────────────────────────────────────
  const queueLogger = createLogger('queue-manager');
  const queueManager = new QueueManager(queueLogger);

  const playbackLogger = createLogger('playback-manager');
  const playbackManager = new PlaybackManager(
    playbackLogger,
    queueManager,
    config.VOICE_IDLE_TIMEOUT_SECONDS,
    guildSettingsManager,
    analyticsManager,
    trackManager,
  );

  // ── API Server ─────────────────────────────────────────────────
  const { server } = createApiServer(
    config.API_PORT,
    playbackManager,
    audioSourceManager,
    artworkService,
    analyticsManager,
    playlistManager,
    trackManager,
  );

  // ── WebSocket ──────────────────────────────────────────────────
  createWebSocketServer(server, playbackManager);

  // ── Discord Bot & Voice Adapter ────────────────────────────────
  let discordConnected = false;
  let discordClient: any = null;
  if (config.DISCORD_TOKEN) {
    try {
      discordClient = await createDiscordBot(
        config.DISCORD_TOKEN,
        playbackManager,
        audioSourceManager,
        analyticsManager,
        playlistManager,
        trackManager,
      );
      const voiceAdapter = new DiscordVoiceAdapter(discordClient);
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
    'Gakki Phase 6 startup complete',
  );

  // ── Graceful Shutdown ─────────────────────────────────────────
  let isShuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info({ signal }, 'Graceful shutdown initiated...');

    try {
      // 1. Finalize active playback events
      await playbackManager.shutdown();

      // 2. Close HTTP/API and WebSocket server
      server.close();

      // 3. Close Discord bot connection
      if (discordClient) {
        discordClient.destroy();
      }

      // 4. Close database pool
      await disconnectDatabase();
      logger.info('Graceful shutdown completed successfully');
    } catch (err) {
      logger.error({ err }, 'Error during graceful shutdown');
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('Fatal error during startup:', error);
  process.exit(1);
});
