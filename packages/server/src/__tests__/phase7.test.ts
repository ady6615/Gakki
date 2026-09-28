import 'dotenv/config';
import {
  QueueManager,
  PlaybackManager,
  VoicePlatformAdapter,
  VoicePlatformState,
  AudioTrackInfo,
  VoiceConnectionStatus,
  PlaybackStatus,
  AudioSource,
  AudioFilterConfig,
  AdapterPlayOptions,
  createLogger,
  TrackManager,
  AnalyticsManager,
  PlaylistManager,
  AudioFeatureManager,
  TrackSimilarityService,
  PreferenceScoringService,
  DynamicDJManager,
  AiRecommendationManager,
  type AcousticFeatures,
} from '@gakki/core';
import { AudioAnalysisClient } from '../services/audio-analysis.client';
import {
  handleChatInputCommand,
} from '../discord/commands';
import * as path from 'path';
import * as fs from 'fs';

const logger = createLogger('phase7-test');

class Phase7MockVoiceAdapter implements VoicePlatformAdapter {
  readonly platform = 'mock-discord';
  private voiceStatuses = new Map<string, VoiceConnectionStatus>();
  private playerStatuses = new Map<string, PlaybackStatus>();
  public currentTracks = new Map<string, AudioTrackInfo | null>();
  public volume: number = 100;
  public activeFilters: AudioFilterConfig = { bassboost: false, speed: 1.0, nightcore: false };
  public playCount: number = 0;
  public lastSource: AudioSource | null = null;
  public humanCount: number = 1;

  private stateListeners = new Set<(state: VoicePlatformState) => void>();
  private errorListeners = new Set<(guildId: string, err: Error) => void>();
  private trackEndListeners = new Set<(guildId: string) => void>();

  async joinVoice(guildId: string, _channelId: string): Promise<void> {
    this.voiceStatuses.set(guildId, 'CONNECTED');
    this.emitState(guildId);
  }

  async leaveVoice(guildId: string): Promise<void> {
    this.stop(guildId);
    this.voiceStatuses.set(guildId, 'DISCONNECTED');
    this.emitState(guildId);
  }

  getVoiceStatus(guildId: string): VoiceConnectionStatus {
    return this.voiceStatuses.get(guildId) || 'DISCONNECTED';
  }

  getPlaybackStatus(guildId: string): PlaybackStatus {
    return this.playerStatuses.get(guildId) || 'IDLE';
  }

  getCurrentTrack(guildId: string): AudioTrackInfo | null {
    return this.currentTracks.get(guildId) || null;
  }

  getState(guildId: string): VoicePlatformState {
    return {
      guildId,
      voiceState: this.getVoiceStatus(guildId),
      playerState: this.getPlaybackStatus(guildId),
      track: this.getCurrentTrack(guildId),
    };
  }

  async play(guildId: string, source: AudioSource, options?: AdapterPlayOptions): Promise<void> {
    this.lastSource = source;
    this.playCount++;
    this.playerStatuses.set(guildId, 'PLAYING');
    if (options?.volume !== undefined) this.volume = options.volume;
    if (options?.filters) this.activeFilters = { ...options.filters };

    const metadata = source.getMetadata ? await source.getMetadata() : { title: 'Unknown' };
    this.currentTracks.set(guildId, {
      name: metadata.title,
      duration: metadata.duration ?? null,
      sourceType: source.sourceType,
      filePath: source.identifier,
      artist: (metadata as any).artist ?? null,
    });

    this.emitState(guildId);
  }

  pause(guildId: string): boolean {
    if (this.playerStatuses.get(guildId) === 'PLAYING') {
      this.playerStatuses.set(guildId, 'PAUSED');
      this.emitState(guildId);
      return true;
    }
    return false;
  }

  resume(guildId: string): boolean {
    if (this.playerStatuses.get(guildId) === 'PAUSED') {
      this.playerStatuses.set(guildId, 'PLAYING');
      this.emitState(guildId);
      return true;
    }
    return false;
  }

  stop(guildId: string): boolean {
    this.playerStatuses.set(guildId, 'IDLE');
    this.currentTracks.set(guildId, null);
    this.emitState(guildId);
    return true;
  }

  setVolume(_guildId: string, volume: number): number {
    this.volume = volume;
    return volume;
  }

  onStateChange(listener: (state: VoicePlatformState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onError(listener: (guildId: string, err: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  onTrackEnd(listener: (guildId: string) => void): () => void {
    this.trackEndListeners.add(listener);
    return () => this.trackEndListeners.delete(listener);
  }

  getChannelHumanCount(_guildId: string): number {
    return this.humanCount;
  }

  public simulateTrackFinish(guildId: string): void {
    this.playerStatuses.set(guildId, 'IDLE');
    this.currentTracks.set(guildId, null);
    this.emitState(guildId);
    for (const listener of this.trackEndListeners) {
      listener(guildId);
    }
  }

  private emitState(guildId: string): void {
    const state = this.getState(guildId);
    for (const listener of this.stateListeners) {
      listener(state);
    }
  }
}

// ── Test Runner Utilities ──────────────────────────────────────────

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assert(condition: any, message: string): void {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  PASS: ${message}`);
  } else {
    failedTests++;
    console.error(`  FAIL: ${message}`);
  }
}

// ── Test Suite Execution ───────────────────────────────────────────

async function runPhase7Tests(): Promise<void> {
  console.log('\n======================================================');
  console.log('   GAKKI MUSIC PLATFORM — PHASE 7 TEST SUITE');
  console.log('   (Audio Analysis, Smart Recommendations & Dynamic DJ)');
  console.log('======================================================\n');

  const evalDir = path.resolve(process.cwd(), 'storage', 'evaluation');
  const ambientPath = path.join(evalDir, 'chill_ambient_60bpm.wav');
  const lofiPath = path.join(evalDir, 'chill_lofi_65bpm.wav');
  const folkPath = path.join(evalDir, 'acoustic_folk_90bpm.wav');
  const dancePath = path.join(evalDir, 'electro_dance_128bpm.wav');

  let featureManager = new AudioFeatureManager(null);
  let trackManager = new TrackManager(null);
  let analyticsManager = new AnalyticsManager(null, logger);
  let playlistManager = new PlaylistManager(null, logger);
  let similarityService = new TrackSimilarityService(logger);
  let preferenceService = new PreferenceScoringService(analyticsManager, playlistManager, logger);
  let djManager = new DynamicDJManager(featureManager, similarityService, preferenceService, trackManager, { recentCooldownCount: 5 }, logger);
  let recManager = new AiRecommendationManager(null, trackManager, analyticsManager, playlistManager, { recentCooldownCount: 5 }, logger);
  let analysisClient = new AudioAnalysisClient(featureManager, { maxConcurrency: 2, jobTimeoutMs: 15000 });

  // ── SUITE 1: Audio Analysis Service & Feature Extraction ─────────
  console.log('--- SUITE 1: Audio Analysis Service & Feature Extraction ---');
  {
    const saved = await trackManager.saveTrackWithSource(
      { title: 'Ambient Track', duration: 2 },
      { provider: 'local', sourceType: 'file', sourceUrl: ambientPath },
    );

    analysisClient.queueAnalysis({ trackId: saved.track.id, filePath: ambientPath });

    let feat: AcousticFeatures | null = null;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 200));
      feat = await featureManager.getFeatures(saved.track.id);
      if (feat && feat.analysisStatus === 'READY') break;
    }

    assert(feat !== null && feat.analysisStatus === 'READY', 'Audio analysis extracts features and sets status to READY');
    assert(feat?.bpm && feat.bpm > 40 && feat.bpm < 100, `BPM is estimated within expected bounds (extracted: ${Math.round(feat?.bpm || 0)})`);
    assert(feat?.energy !== null && feat!.energy! >= 0 && feat!.energy! <= 1, `RMS acoustic energy normalized in [0, 1] (extracted: ${feat?.energy?.toFixed(2)})`);
    assert(feat?.embedding && feat.embedding.length === 32, 'Generates compact 32-dimensional normalized acoustic embedding');

    // Corrupted file test
    const brokenPath = path.resolve(process.cwd(), 'storage', 'evaluation', 'corrupted_test.mp3');
    fs.writeFileSync(brokenPath, Buffer.from('NOT AUDIO GARBAGE DATA'));

    try {
      const brokenSaved = await trackManager.saveTrackWithSource(
        { title: 'Corrupted', duration: 1 },
        { provider: 'local', sourceType: 'file', sourceUrl: brokenPath },
      );

      analysisClient.queueAnalysis({ trackId: brokenSaved.track.id, filePath: brokenPath });

      let brokenFeat: AcousticFeatures | null = null;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 200));
        brokenFeat = await featureManager.getFeatures(brokenSaved.track.id);
        if (brokenFeat && brokenFeat.analysisStatus === 'FAILED') break;
      }

      assert(brokenFeat?.analysisStatus === 'FAILED', 'Corrupted audio file fails gracefully and marks status as FAILED');
      assert(brokenFeat?.errorMessage !== null, 'Analysis failure persists actionable error message');
    } finally {
      if (fs.existsSync(brokenPath)) fs.unlinkSync(brokenPath);
    }

    // Content hash cache test
    const mockHashFeatures: AcousticFeatures = {
      trackId: 'track-hash-seed',
      featureVersion: 1,
      embeddingVersion: 1,
      bpm: 120,
      tempoConfidence: 0.9,
      energy: 0.65,
      key: 'Am',
      spectralCentroid: 2000,
      spectralBandwidth: 1800,
      spectralContrast: 20,
      spectralRolloff: 4000,
      spectralFlatness: 0.04,
      zeroCrossingRate: 0.05,
      chroma: Array(12).fill(0.08),
      mfcc: Array(13).fill(1.0),
      rhythmFeatures: { bpm: 120 },
      embedding: Array(32).fill(0.176),
      analysisStatus: 'READY',
      contentHash: 'content-hash-deterministic-xyz',
      analyzedAt: new Date(),
      errorMessage: null,
    };

    await featureManager.saveFeatures(mockHashFeatures);
    const cached = await featureManager.findByContentHash('content-hash-deterministic-xyz');
    assert(cached?.bpm === 120 && cached.energy === 0.65, 'Content hash deduplication retrieves cached features without re-analysis');
  }

  // ── SUITE 2: Hybrid Similarity & Acoustic Relationships ──────────
  console.log('\n--- SUITE 2: Hybrid Similarity & Acoustic Relationships ---');
  {
    const ambientFeatures: AcousticFeatures = {
      trackId: 't-ambient',
      featureVersion: 1,
      embeddingVersion: 1,
      bpm: 60,
      tempoConfidence: 0.9,
      energy: 0.22,
      key: 'Cm',
      spectralCentroid: 1500,
      spectralBandwidth: 1200,
      spectralContrast: 15,
      spectralRolloff: 2500,
      spectralFlatness: 0.02,
      zeroCrossingRate: 0.02,
      chroma: [0.3, 0.1, 0.1, 0.3, 0.1, 0.1, 0.1, 0.2, 0.1, 0.1, 0.1, 0.1],
      mfcc: [-250, 80, 10, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      rhythmFeatures: { bpm: 60 },
      embedding: Array(32).fill(0.1),
      analysisStatus: 'READY',
      contentHash: null,
      analyzedAt: new Date(),
      errorMessage: null,
    };

    const lofiFeatures: AcousticFeatures = {
      ...ambientFeatures,
      trackId: 't-lofi',
      bpm: 65,
      energy: 0.32,
      embedding: Array(32).fill(0.11),
    };

    const danceFeatures: AcousticFeatures = {
      ...ambientFeatures,
      trackId: 't-dance',
      bpm: 128,
      energy: 0.95,
      embedding: Array(32).fill(0.25),
    };

    const simLofi = similarityService.computeHybridSimilarity(ambientFeatures, lofiFeatures, 'CHILL');
    const simDance = similarityService.computeHybridSimilarity(ambientFeatures, danceFeatures, 'CHILL');

    assert(simLofi.score > simDance.score, `Ambient ranks closer to Lo-Fi (${simLofi.score.toFixed(3)}) than to Dance (${simDance.score.toFixed(3)})`);
    assert(simLofi.reasons.length > 0, 'Hybrid similarity produces explainable reason tags');

    // Tempo octave handling
    const simOctaveDouble = similarityService.computeTempoCompatibility(90, 180);
    const simOctaveHalf = similarityService.computeTempoCompatibility(144, 72);
    const simClashing = similarityService.computeTempoCompatibility(60, 175);

    assert(simOctaveDouble > 0.9, 'Handles 2x double-time tempo compatibility (90 BPM ≈ 180 BPM)');
    assert(simOctaveHalf > 0.9, 'Handles 0.5x half-time tempo compatibility (144 BPM ≈ 72 BPM)');
    assert(simClashing < 0.4, 'Penalizes clashing incompatible tempos');

    // Profile adaptability
    const chillScore = similarityService.computeEnergyCompatibility(0.25, 0.3, 'CHILL');
    const energeticPenalty = similarityService.computeEnergyCompatibility(0.25, 0.95, 'CHILL');
    assert(chillScore > 0.85, 'CHILL profile rewards low/compatible energy transitions');
    assert(energeticPenalty < 0.4, 'CHILL profile penalizes jarring high-energy jumps');
  }

  // ── SUITE 3: Preference Scoring & Implicit Signals ───────────────
  console.log('\n--- SUITE 3: Preference Scoring & Implicit Signals ---');
  {
    const guildId = 'guild-pref-suite';
    const userA = 'user-listener-A';
    const userB = 'user-skipper-B';
    const trackFav = 'track-fav-1';
    const trackSkip = 'track-skip-1';

    // User A: 3 full listens of trackFav
    for (let i = 0; i < 3; i++) {
      const evId = await analyticsManager.recordPlaybackStart({
        guildId,
        userId: userA,
        trackId: trackFav,
        trackTitle: 'Favorite Track',
        source: 'local',
      });
      await analyticsManager.recordPlaybackEnd(evId, {
        endedAt: new Date(),
        durationListened: 180,
        completed: true,
        endReason: 'finished',
      });
    }

    const scoreFav = await preferenceService.computeUserTrackPreference(userA, trackFav, guildId);
    assert(scoreFav > 0.4 && scoreFav <= 1.0, `Completed & repeated listens yield positive interaction preference score (${scoreFav})`);

    // User B: 2 early skips of trackSkip
    for (let i = 0; i < 2; i++) {
      const evId = await analyticsManager.recordPlaybackStart({
        guildId,
        userId: userB,
        trackId: trackSkip,
        trackTitle: 'Skipped Track',
        source: 'local',
      });
      await analyticsManager.recordPlaybackEnd(evId, {
        endedAt: new Date(),
        durationListened: 6,
        completed: false,
        endReason: 'skipped',
      });
    }

    const scoreSkip = await preferenceService.computeUserTrackPreference(userB, trackSkip, guildId);
    assert(scoreSkip < 0.0 && scoreSkip >= -1.0, `Early skips yield negative interaction preference score (${scoreSkip})`);

    // Multi-user active listener blending
    const groupResult = await preferenceService.computeGroupPreference(guildId, trackFav, [userA, userB]);
    assert(Object.keys(groupResult.listenerScores).length === 2, 'Evaluates all active voice channel listeners');
    assert(groupResult.listenerScores[userA] > groupResult.listenerScores[userB], 'Listener-specific scores preserved individually');
    assert(groupResult.groupScore >= -1.0 && groupResult.groupScore <= 1.0, 'Blended group score bounded in [-1, 1]');
  }

  // ── SUITE 4: Cold-Start Fallback & Candidate Filtering ───────────
  console.log('\n--- SUITE 4: Cold-Start Fallback & Candidate Filtering ---');
  {
    const coldGuild = 'guild-cold-start';
    const candidates = [
      { trackId: 'cand-alpha', title: 'Alpha', artist: 'Artist A' },
      { trackId: 'cand-beta', title: 'Beta', artist: 'Artist B' },
      { trackId: 'cand-gamma', title: 'Gamma', artist: 'Artist C' },
    ];

    const coldResult = await djManager.generateRecommendations({
      guildId: coldGuild,
      candidatePool: candidates,
      limit: 2,
    });

    assert(coldResult.tracks.length === 2, 'Cold start (0 history) succeeds without crashing');
    assert(coldResult.algorithmVersion === 'v1', 'Tracks algorithm version in recommendation metadata');

    // Cooldown window
    djManager.recordPlayedTrack(coldGuild, 'cand-alpha');
    const nextChosen = await djManager.selectNextTrack({
      guildId: coldGuild,
      candidatePool: candidates,
    });

    assert(nextChosen?.trackId !== 'cand-alpha', `Enforces recent-track cooldown window (chose ${nextChosen?.trackId} instead of recently played cand-alpha)`);
  }

  // ── SUITE 5: Smart Shuffle Pipeline ──────────────────────────────
  console.log('\n--- SUITE 5: Smart Shuffle Pipeline ---');
  {
    const guildId = 'guild-shuffle-suite';
    const queueTracks = [
      { id: 'q-1', trackId: 't-1', name: 'Ambient', path: ambientPath },
      { id: 'q-2', trackId: 't-2', name: 'Dance', path: dancePath },
      { id: 'q-3', trackId: 't-3', name: 'Lofi', path: lofiPath },
      { id: 'q-4', trackId: 't-4', name: 'Folk', path: folkPath },
    ];

    const shuffled = await djManager.smartShuffle(guildId, queueTracks as any, null, 'BALANCED');
    assert(shuffled.length === queueTracks.length, 'Smart shuffle preserves all queue tracks');
    const idSet = new Set(shuffled.map((t) => t.id));
    assert(idSet.size === 4, 'Smart shuffle produces zero dropped or duplicate tracks');
  }

  // ── SUITE 6: Dynamic DJ Mode & Lookahead Queue ───────────────────
  console.log('\n--- SUITE 6: Dynamic DJ Mode & Lookahead Queue ---');
  {
    const guildId = 'guild-dj-suite';
    djManager.configureDJ(guildId, { enabled: true, profile: 'BALANCED' });

    const candidates = [
      { trackId: 'dj-1', title: 'Track 1', artist: null },
      { trackId: 'dj-2', title: 'Track 2', artist: null },
      { trackId: 'dj-3', title: 'Track 3', artist: null },
    ];

    const pick1 = await djManager.selectNextTrack({ guildId, candidatePool: candidates });
    assert(pick1 !== null, 'Dynamic DJ selects next track');
    const state = djManager.getDJState(guildId);
    assert(state.lookaheadQueue.length > 0, `Maintains adaptive lookahead queue (${state.lookaheadQueue.length} tracks buffered)`);

    // Natural track completion auto-advance test
    const mockAdapter = new Phase7MockVoiceAdapter();
    const queueMgr = new QueueManager(logger);
    const playbackMgr = new PlaybackManager(logger, queueMgr, 300, undefined, analyticsManager, trackManager);
    playbackMgr.registerAdapter(mockAdapter);

    const autoGuild = 'guild-auto-advance';
    djManager.configureDJ(autoGuild, { enabled: true, profile: 'BALANCED' });

    const s1 = await trackManager.saveTrackWithSource({ title: 'Playing 1', duration: 2 }, { provider: 'local', sourceType: 'file', sourceUrl: ambientPath });
    const s2 = await trackManager.saveTrackWithSource({ title: 'Playing 2', duration: 2 }, { provider: 'local', sourceType: 'file', sourceUrl: lofiPath });

    const src1 = playbackMgr.createAudioSource({ id: s1.track.id, name: s1.track.title, path: ambientPath } as any);
    await playbackMgr.play(autoGuild, src1, { trackId: s1.track.id, name: s1.track.title, path: ambientPath });
    assert(mockAdapter.getPlaybackStatus(autoGuild) === 'PLAYING', 'Initial track started playback');

    // Register auto-advance listener as in main server index.ts
    playbackMgr.onPlaybackEvent(async (event) => {
      if (event.type === 'playback.ended' && djManager.getDJState(autoGuild).enabled && queueMgr.isEmpty(autoGuild)) {
        const candidate = await djManager.selectNextTrack({ autoGuild, seedTrackId: event.trackId } as any);
        if (candidate) {
          const nextTrack = await trackManager.getTrackById(candidate.trackId);
          if (nextTrack) {
            const primary = await trackManager.getPrimarySourceByTrackId(nextTrack.id);
            if (primary?.sourceUrl && fs.existsSync(primary.sourceUrl)) {
              const src = playbackMgr.createAudioSource({ id: nextTrack.id, name: nextTrack.title, path: primary.sourceUrl } as any);
              await playbackMgr.play(autoGuild, src, { trackId: nextTrack.id, name: nextTrack.title, path: primary.sourceUrl });
            }
          }
        }
      }
    });

    mockAdapter.simulateTrackFinish(autoGuild);
    await new Promise((r) => setTimeout(r, 600));
    assert(mockAdapter.playCount === 2, 'Dynamic DJ automatically advances and plays next track when queue ends');
  }

  // ── SUITE 7: Multi-Guild Isolation ───────────────────────────────
  console.log('\n--- SUITE 7: Multi-Guild Isolation ---');
  {
    const guildA = 'guild-iso-A';
    const guildB = 'guild-iso-B';

    djManager.configureDJ(guildA, { enabled: true, profile: 'ENERGETIC' });
    djManager.recordPlayedTrack(guildA, 'track-isolated-A');

    const stateA = djManager.getDJState(guildA);
    const stateB = djManager.getDJState(guildB);

    assert(stateA.enabled === true, 'Guild A DJ mode enabled');
    assert(stateA.profile === 'ENERGETIC', 'Guild A profile is ENERGETIC');
    assert(stateA.recentTrackIds.includes('track-isolated-A'), 'Guild A records cooldown track');

    assert(stateB.enabled === false, 'Guild B DJ mode remains independent (disabled)');
    assert(stateB.profile === 'BALANCED', 'Guild B maintains independent default profile');
    assert(stateB.recentTrackIds.length === 0, 'Guild B cooldown history is completely isolated');
  }

  // ── SUITE 8: Discord Slash Command Handlers ──────────────────────
  console.log('\n--- SUITE 8: Discord Slash Command Handlers ---');
  {
    const guildId = 'guild-slash-suite';
    const mockAdapter = new Phase7MockVoiceAdapter();
    const queueMgr = new QueueManager(logger);
    const playbackMgr = new PlaybackManager(logger, queueMgr);
    playbackMgr.registerAdapter(mockAdapter);

    // /dj on
    let onReply = '';
    const mockOnInteraction: any = {
      commandName: 'dj',
      guildId,
      user: { id: 'admin-1', username: 'DJ User' },
      options: {
        getSubcommand: () => 'on',
        getString: () => 'CHILL',
      },
      reply: async (msg: any) => { onReply = typeof msg === 'string' ? msg : msg.content; },
    };

    await handleChatInputCommand(mockOnInteraction, playbackMgr, undefined, undefined, undefined, undefined, recManager);
    assert(onReply.includes('Dynamic DJ is now ON'), '/dj on responds with confirmation');
    assert(recManager.getDJState(guildId).enabled === true, '/dj on updates DJ state to enabled');

    // /dj off
    let offReply = '';
    const mockOffInteraction: any = {
      ...mockOnInteraction,
      options: { getSubcommand: () => 'off' },
      reply: async (msg: any) => { offReply = typeof msg === 'string' ? msg : msg.content; },
    };

    await handleChatInputCommand(mockOffInteraction, playbackMgr, undefined, undefined, undefined, undefined, recManager);
    assert(offReply.includes('Dynamic DJ is now OFF'), '/dj off responds with confirmation');
    assert(recManager.getDJState(guildId).enabled === false, '/dj off updates DJ state to disabled');

    // /vibe
    await trackManager.saveTrackWithSource({ title: 'After Dark Seed', duration: 200 }, { provider: 'local', sourceType: 'file', sourceUrl: ambientPath });
    await trackManager.saveTrackWithSource({ title: 'Nightcall Vibe', duration: 200 }, { provider: 'local', sourceType: 'file', sourceUrl: lofiPath });

    let vibeDeferred: boolean = false;
    let vibeEmbeds: any[] = [];
    const mockVibeInteraction: any = {
      commandName: 'vibe',
      guildId,
      user: { id: 'u-1', username: 'VibeSeeker' },
      deferReply: async () => { vibeDeferred = true; },
      editReply: async (data: any) => { vibeEmbeds = data.embeds || []; },
      options: {
        getString: (name: string) => (name === 'track' ? 'After Dark Seed' : 'BALANCED'),
      },
    };

    await handleChatInputCommand(mockVibeInteraction, playbackMgr, undefined, undefined, undefined, trackManager, recManager);
    assert(vibeDeferred, '/vibe defers reply for calculation');
    assert(vibeEmbeds.length === 1 && vibeEmbeds[0].data.title.includes('VIBE MATCH'), '/vibe replies with rich VIBE MATCH embed');
  }

  // ── Test Summary ─────────────────────────────────────────────────
  console.log('\n======================================================');
  console.log(`   PHASE 7 TEST RESULTS: ${passedTests}/${totalTests} PASSED (${failedTests} FAILED)`);
  console.log('======================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runPhase7Tests().catch((err) => {
  console.error('Fatal error during Phase 7 test execution:', err);
  process.exit(1);
});
