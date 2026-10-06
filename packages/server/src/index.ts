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
  RecordingManager,
  TranscriptionManager,
  TranscriptionProviderRegistry,
  MockTranscriptionProvider,
  WhisperLocalProvider,
  VoiceCommandEngine,
  DJCommentaryEngine,
  TTSProviderRegistry,
  VoiceSessionManager,
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
import { VoiceReceiverManager } from './voice';
import { MeetVoiceAdapter } from './meet/meet-voice.adapter';
import { MeetOAuthService } from './meet/meet-oauth.service';
import { GeminiLiveVoiceProvider } from './voice/gemini-live-voice.provider';
import { VoiceRateLimiter } from './security/voice-rate-limiter';
import { resolveAnyAudioInput } from './audio/track-resolver';

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

  // Automatically trigger asynchronous background audio analysis and stem separation when new local tracks enter library
  trackManager.onTrackSaved((savedTrack, source) => {
    if (source && source.sourceUrl) {
      const isLocalFile = source.sourceType === 'file' || !source.sourceUrl.startsWith('http');
      if (isLocalFile) {
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

  // Wire dynamic stream resolver so queued Spotify/YouTube/search tracks resolve on-the-fly
  playbackManager.setAudioSourceResolver(async (input: string) => {
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

  // ── Phase 11: Voice Recording & Transcription Subsystem ─────────
  const recordingManager = dbPool ? new RecordingManager(dbPool) : undefined;
  if (recordingManager) {
    await recordingManager.cleanOrphanedRecordings();
  }

  const transcriptionRegistry = new TranscriptionProviderRegistry();
  const transcriptionManager = dbPool
    ? new TranscriptionManager(dbPool, transcriptionRegistry, {
        defaultProvider: 'whisper-local',
        maxConcurrentJobs: 2,
      })
    : undefined;

  const voiceReceiver = new VoiceReceiverManager(
    undefined,
    recordingManager as any,
    transcriptionManager,
    (event: any) => broadcastEvent(event),
  );

  // ── Phase 13: Voice Commands, Gemini Voice Agent & Google Meet ──
  const voiceSessionManager = new VoiceSessionManager();
  const ttsRegistry = new TTSProviderRegistry();
  const djCommentaryEngine = new DJCommentaryEngine(ttsRegistry, {
    enabled: true,
    cooldownSeconds: 180,
    mixingMode: 'BETWEEN_SONGS',
    voiceProfile: 'Puck',
  });

  const meetOAuthService = new MeetOAuthService();
  const meetAdapter = new MeetVoiceAdapter({
    oauthService: meetOAuthService,
    recordingManager: recordingManager,
    transcriptionManager: transcriptionManager,
  });
  playbackManager.registerAdapter(meetAdapter);
  voiceSessionManager.registerAdapter(meetAdapter);

  const geminiLiveProvider = new GeminiLiveVoiceProvider();
  const voiceRateLimiter = new VoiceRateLimiter();
  const voiceCommandEngine = new VoiceCommandEngine();
  voiceCommandEngine.setGeminiProvider(geminiLiveProvider);
  geminiLiveProvider.setVoiceResponseOutput(voiceCommandEngine.getVoiceResponseOutput());

  // Wire VoiceCommandEngine callbacks to Playback & Music Engines
  voiceCommandEngine.setMusicCallbacks({
    playTrack: async (query, context) => {
      const gid = context.guildId || 'desktop-local';
      try {
        const found = await audioSourceManager.search(query, { limit: 1 });
        if (found && found.length > 0) {
          const item = found[0];
          const source = playbackManager.createAudioSource({
            id: item.sourceUrl,
            trackId: item.sourceUrl,
            name: item.title,
            path: item.sourceUrl,
            duration: item.duration ?? undefined,
            artist: item.artist,
            album: item.album,
          } as any);

          await playbackManager.play(gid, source, {
            trackId: item.sourceUrl,
            name: item.title,
            path: item.sourceUrl,
            artist: item.artist,
            album: item.album,
            addedBy: context.userDisplayName || 'Voice Command',
          });
          return { success: true, trackName: item.title };
        }
        return { success: false, error: 'No track found matching search' };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },
    pause: async (context) => {
      const gid = context.guildId || 'desktop-local';
      return playbackManager.pause(gid);
    },
    resume: async (context) => {
      const gid = context.guildId || 'desktop-local';
      return playbackManager.resume(gid);
    },
    skip: async (context) => {
      const gid = context.guildId || 'desktop-local';
      const skipRes = await playbackManager.skip(gid);
      return Boolean(skipRes && skipRes.skipped);
    },
    stop: async (context) => {
      const gid = context.guildId || 'desktop-local';
      return playbackManager.stop(gid);
    },
    setVolume: async (vol, context) => {
      const gid = context.guildId || 'desktop-local';
      playbackManager.setVolume(gid, vol);
      return true;
    },
    smartShuffle: async (context) => {
      const gid = context.guildId || 'desktop-local';
      try {
        await recManager.smartShuffle(
          gid,
          playbackManager.queueManager.inspectQueue(gid),
          playbackManager.getCurrentTrack(gid) as any,
        );
        return true;
      } catch {
        return false;
      }
    },
    enableDJ: async (context) => {
      const gid = context.guildId || 'desktop-local';
      recManager.djManager.configureDJ(gid, { enabled: true });
      return true;
    },
    disableDJ: async (context) => {
      const gid = context.guildId || 'desktop-local';
      recManager.djManager.configureDJ(gid, { enabled: false });
      return true;
    },
    playPlaylist: async (name, context) => {
      const gid = context.guildId || 'desktop-local';
      try {
        const { userPlaylists, guildPlaylists } = await playlistManager.listPlaylists({ guildId: gid });
        const allPlaylists = [...userPlaylists, ...guildPlaylists];
        const matched = allPlaylists.find((p) => p.name.toLowerCase() === name.toLowerCase());
        if (matched) {
          const fullPlaylist = await playlistManager.getPlaylist(matched.id);
          if (fullPlaylist && fullPlaylist.tracks) {
            for (const pt of fullPlaylist.tracks) {
              const track = await trackManager.getTrackById(pt.trackId);
              if (track) {
                const primarySource = await trackManager.getPrimarySourceByTrackId(track.id);
                if (primarySource) {
                  playbackManager.queueManager.enqueue(gid, {
                    id: track.id,
                    trackId: track.id,
                    name: track.title,
                    path: primarySource.sourceUrl,
                    artist: track.artist,
                    duration: track.duration || undefined,
                    addedBy: 'Voice Playlist',
                  });
                }
              }
            }
            return true;
          }
        }
        return false;
      } catch {
        return false;
      }
    },
    showLyrics: async (context) => {
      const gid = context.guildId || 'desktop-local';
      const current = playbackManager.getCurrentTrack(gid);
      if (!current) return { success: false };
      try {
        const lyr = await lyricsManager.getLyrics({ title: current.name, artist: current.artist || undefined });
        return { success: Boolean(lyr), lyrics: lyr?.plainLyrics || undefined };
      } catch {
        return { success: false };
      }
    },
    saveFavorite: async (context) => {
      const gid = context.guildId || 'desktop-local';
      const current = playbackManager.getCurrentTrack(gid);
      if (!current || !favoritesManager || !current.id) return false;
      try {
        await favoritesManager.addFavorite(context.userId || 'user_local', current.id);
        return true;
      } catch {
        return false;
      }
    },
    setLoop: async (mode, context) => {
      const gid = context.guildId || 'desktop-local';
      if (guildSettingsManager) {
        const curr = await guildSettingsManager.getSettings(gid);
        curr.loopMode = mode;
        await guildSettingsManager.saveSettings(curr);
      }
      return true;
    },
    searchLibrary: async (query) => {
      try {
        const results = await audioSourceManager.search(query, { limit: 5 });
        return results.map((t, idx) => ({
          id: t.sourceUrl || `track_${idx}`,
          title: t.title,
          artist: t.artist,
          duration: t.duration,
        }));
      } catch {
        return [];
      }
    },
  });

  // Forward Voice Events to WebSockets
  voiceCommandEngine.on('wake_word_detected', (data) => {
    broadcastEvent({ type: 'voice.wake_word.detected', ...data });
  });
  voiceCommandEngine.on('intent_executed', (data) => {
    broadcastEvent({ type: 'voice.intent.executed', ...data });
  });
  voiceCommandEngine.on('barge_in', (data) => {
    broadcastEvent({ type: 'voice.barge_in', ...data });
  });
  voiceCommandEngine.on('state_changed', (state) => {
    broadcastEvent({ type: 'voice.state.updated', state });
  });
  djCommentaryEngine.on('commentary_pregenerated', (data) => {
    broadcastEvent({ type: 'dj.commentary.generated', ...data });
  });

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
    recordingManager,
    transcriptionManager,
    voiceReceiver,
    voiceCommandEngine,
    djCommentaryEngine,
    voiceSessionManager,
    meetAdapter,
    geminiLiveProvider,
    voiceRateLimiter,
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
        recordingManager,
        voiceReceiver,
      );
      const voiceAdapter = new DiscordVoiceAdapter(discordClient);
      playbackManager.registerAdapter(voiceAdapter);
      voiceReceiver.setVoiceAdapter(voiceAdapter);
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
      recording: 'active',
      transcription: transcriptionRegistry.getAvailableProviders().join(', '),
    },
    'Gakki Phase 11 startup complete',
  );

  // ── Graceful Shutdown ─────────────────────────────────────────
  let isShuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info({ signal }, 'Graceful shutdown initiated...');

    try {
      // 1. Finalize active recording sessions
      await voiceReceiver.shutdown();

      // 2. Finalize active playback events
      await playbackManager.shutdown();

      // 3. Close HTTP/API and WebSocket server
      server.close();

      // 4. Close Discord bot connection
      if (discordClient) {
        discordClient.destroy();
      }

      // 5. Close database pool
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
