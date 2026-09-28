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
  AiRecommendationManager,
  TransitionFeatureManager,
  StemManager,
  getDatabasePool,
  LyricsManager,
  FavoritesManager,
  LibraryManager,
} from '@gakki/core';
import { createApiServer } from './api/server';
import { createDiscordBot, DiscordVoiceAdapter } from './discord';
import { createWebSocketServer, broadcastEvent } from './websocket';
import { ArtworkService } from './services/artwork.service';
import { createConfiguredAudioSourceManager } from './sources';
import { AudioAnalysisClient } from './services/audio-analysis.client';
import { detectFFmpegCapabilities } from './audio/ffmpeg-capabilities';
import { TransitionProcessor } from './audio/transition-processor';
import { StemProviderRegistry } from './audio/stems/stem-provider.registry';
import { StemWorkerPool } from './audio/stems/stem-worker-pool';

const logger = createLogger('main');

async function main(): Promise<void> {
  logger.info('Starting Gakki Music Platform — Phase 8 (Seamless Audio Mixing, Crossfading & Advanced DJ Transitions)...');

  // ── FFmpeg Capability Detection ─────────────────────────────────
  const ffmpegCaps = await detectFFmpegCapabilities();
  logger.info(
    {
      acrossfade: ffmpegCaps.acrossfade,
      rubberband: ffmpegCaps.rubberband,
      loudnorm: ffmpegCaps.loudnorm,
      atempo: ffmpegCaps.atempo,
    },
    'FFmpeg capabilities detected at startup',
  );

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

  // ── Phase 7: AI Recommendation & Dynamic DJ Manager ─────────────
  const recLogger = createLogger('ai-recommendation');
  const recManager = new AiRecommendationManager(
    dbClient,
    trackManager,
    analyticsManager,
    playlistManager,
    { recentCooldownCount: config.RECOMMENDATION_RECENT_TRACK_COOLDOWN },
    recLogger,
  );

  // ── Phase 8: Transition Feature Manager ─────────────────────────
  const transitionFeatureManager = new TransitionFeatureManager(dbClient);

  // ── Phase 7: Python Audio Analysis Client ───────────────────────
  const analysisClient = new AudioAnalysisClient(recManager.featureManager, {
    serviceUrl: config.AUDIO_ANALYZER_URL,
    maxConcurrency: 2,
    jobTimeoutMs: 30000,
    transitionFeatureManager,
  });

  // ── Phase 9: Stem Separation & Storage Lifecycle ────────────────
  const stemManager = new StemManager(dbClient);
  await stemManager.cleanOrphanedStems();

  const stemRegistry = StemProviderRegistry.getInstance();
  const stemWorkerPool = StemWorkerPool.getInstance(stemManager);
  const stemCaps = await stemRegistry.discoverCapabilities();
  logger.info('Stem Separation Providers:');
  for (const [name, cap] of Object.entries(stemCaps)) {
    logger.info(`  ${name}: ${cap.available ? 'available' : 'unavailable'} (${cap.computeBackend})`);
  }

  // Automatically trigger asynchronous background audio analysis and stem separation when new tracks enter library
  trackManager.onTrackSaved((savedTrack, source) => {
    if (source && source.sourceUrl) {
      analysisClient.queueAnalysis({
        trackId: savedTrack.id,
        filePath: source.sourceUrl,
      });

      stemWorkerPool.enqueue(
        {
          trackId: savedTrack.id,
          filePath: source.sourceUrl,
          title: savedTrack.title,
          duration: savedTrack.duration || 180,
        },
        { storageMode: 'persistent' },
        'LOW',
      );
    }
  });

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
    transitionFeatureManager,
    stemManager,
  );

  // ── Phase 8: Transition Processor & Real-Time Pipe ──────────────
  const transitionProcessor = new TransitionProcessor();
  playbackManager.setTransitionRenderer(transitionProcessor);

  // Broadcast DJ transition events to WebSocket
  playbackManager.onTransitionEvent((event) => {
    broadcastEvent(event);
  });

  // ── Dynamic DJ Auto-Selection on Track End ──────────────────────
  playbackManager.onPlaybackEvent(async (event) => {
    if (event.type === 'playback.ended') {
      const { guildId, trackId } = event;
      if (!guildId || !trackId) return;

      // Update cooldown history & energy tracking in DJ manager
      const features = await recManager.featureManager.getFeatures(trackId);
      recManager.djManager.recordPlayedTrack(guildId, trackId, features);

      // If DJ Mode is ON for this guild, check if queue has ended
      const djState = recManager.getDJState(guildId);
      if (djState.enabled && playbackManager.queueManager.isEmpty(guildId)) {
        logger.info({ guildId }, '[DJ] Queue empty with Dynamic DJ active — selecting next track');
        try {
          const candidate = await recManager.selectNextTrack({
            guildId,
            seedTrackId: trackId,
          });

          if (candidate) {
            const nextTrack = await trackManager.getTrackById(candidate.trackId);
            if (nextTrack) {
              const primarySource = await trackManager.getPrimarySourceByTrackId(nextTrack.id);
              const trackPath = primarySource ? primarySource.sourceUrl : '';
              if (trackPath) {
                const source = playbackManager.createAudioSource({
                  id: nextTrack.id,
                  trackId: nextTrack.id,
                  name: nextTrack.title,
                  path: trackPath,
                  duration: nextTrack.duration ?? undefined,
                  artist: nextTrack.artist,
                  album: nextTrack.album,
                } as any);

                await playbackManager.play(guildId, source, {
                  trackId: nextTrack.id,
                  name: nextTrack.title,
                  path: trackPath,
                  duration: nextTrack.duration ?? undefined,
                  artist: nextTrack.artist,
                  album: nextTrack.album,
                  addedBy: 'Dynamic DJ',
                });

                broadcastEvent({
                  type: 'dj.next.selected',
                  guildId,
                  trackId: nextTrack.id,
                  title: nextTrack.title,
                  reasons: candidate.reasons,
                  explanation: candidate.explanation,
                  finalScore: candidate.finalScore,
                });
              }
            }
          }
        } catch (djErr) {
          logger.error({ err: djErr, guildId }, '[DJ] Error auto-selecting next track');
        }
      }
    }
  });

  // ── Phase 10: Lyrics, Favorites & Library Services ─────────────
  const dbPool = getDatabasePool() || undefined;
  const lyricsManager = new LyricsManager({ pool: dbPool });
  const favoritesManager = dbPool ? new FavoritesManager(dbPool) : undefined;
  const libraryManager = dbPool ? new LibraryManager(dbPool, recManager.featureManager, recManager) : undefined;

  // ── API Server ─────────────────────────────────────────────────
  const { server } = createApiServer(
    config.API_PORT,
    playbackManager,
    audioSourceManager,
    artworkService,
    analyticsManager,
    playlistManager,
    trackManager,
    recManager,
    lyricsManager,
    favoritesManager,
    libraryManager,
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
        recManager,
        lyricsManager,
        favoritesManager,
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
      analyzer: config.AUDIO_ANALYZER_URL,
    },
    'Gakki Phase 7 startup complete',
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
