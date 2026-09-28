import 'dotenv/config';
import * as path from 'path';
import * as fs from 'fs';
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
  KeyCompatibilityService,
  CuePointService,
  TransitionEngine,
  TRANSITION_PROFILES,
  type TrackTransitionFeatures,
  type TransitionPlan,
  type GuildTransitionSettings,
} from '@gakki/core';
import {
  detectFFmpegCapabilities,
  getFFmpegCapabilities,
  type FFmpegFilterCapabilities,
} from '../audio/ffmpeg-capabilities';
import { TransitionProcessor } from '../audio/transition-processor';
import { handleChatInputCommand } from '../discord/commands';

const logger = createLogger('phase8-test');

class Phase8MockVoiceAdapter implements VoicePlatformAdapter {
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

class MockAudioSource implements AudioSource {
  readonly sourceType = 'file';
  constructor(
    public readonly identifier: string,
    public readonly title: string,
    public readonly duration: number = 180,
  ) {}

  async validate(): Promise<void> {
    return;
  }

  async getStream(): Promise<any> {
    const { PassThrough } = await import('node:stream');
    const pt = new PassThrough();
    pt.end(Buffer.alloc(100));
    return pt;
  }

  async getMetadata() {
    return { title: this.title, duration: this.duration, artist: 'Test Artist' };
  }
}

async function runPhase8Tests() {
  console.log('======================================================');
  console.log('   GAKKI MUSIC PLATFORM — PHASE 8 VERIFICATION SUITE');
  console.log('   Seamless Mixing, DJ Transitions & DSP Pipeline');
  console.log('======================================================\n');

  let passedTests = 0;
  let failedTests = 0;
  let totalTests = 0;

  function assert(condition: boolean, testName: string, details?: string) {
    totalTests++;
    if (condition) {
      console.log(`  ✓ [PASS] ${testName}`);
      passedTests++;
    } else {
      console.error(`  ✗ [FAIL] ${testName}${details ? ` -> ${details}` : ''}`);
      failedTests++;
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // SUITE 1: FFmpeg Capability Detection & Startup Detection
  // ─────────────────────────────────────────────────────────────────
  console.log('\n--- SUITE 1: FFmpeg Capability Detection ---');
  {
    const caps = await detectFFmpegCapabilities();
    assert(typeof caps.acrossfade === 'boolean', 'Capability detection returns acrossfade boolean');
    assert(typeof caps.rubberband === 'boolean', 'Capability detection returns rubberband boolean');
    assert(typeof caps.loudnorm === 'boolean', 'Capability detection returns loudnorm boolean');
    assert(typeof caps.atempo === 'boolean', 'Capability detection returns atempo boolean');
    assert(caps.acrossfade === true, 'FFmpeg binary supports acrossfade filter');
    assert(caps.loudnorm === true, 'FFmpeg binary supports loudnorm filter');
    assert(caps.atempo === true, 'FFmpeg binary supports atempo filter');

    // Cached retrieval
    const cachedCaps = getFFmpegCapabilities();
    assert(cachedCaps?.acrossfade === caps.acrossfade, 'getFFmpegCapabilities retrieves cached result');
  }

  // ─────────────────────────────────────────────────────────────────
  // SUITE 2: Harmonic Mixing & Camelot Wheel Compatibility Matrix
  // ─────────────────────────────────────────────────────────────────
  console.log('\n--- SUITE 2: Key Compatibility & Camelot Matrix ---');
  {
    const keyService = new KeyCompatibilityService();

    // 1. Same Key
    const sameKeyMatch = keyService.evaluateCamelotRelationship('8A', '8A');
    assert(sameKeyMatch.relationship === 'SAME_KEY', 'Same key identified (8A -> 8A)');
    assert(sameKeyMatch.score === 1.0, 'Same key returns compatibility 1.0');

    // 2. Relative Major/Minor
    const relativeMatch = keyService.evaluateCamelotRelationship('8A', '8B');
    assert(relativeMatch.relationship === 'RELATIVE_MAJOR_MINOR', 'Relative major/minor identified (8A -> 8B)');
    assert(relativeMatch.score === 0.95, 'Relative key returns compatibility 0.95');

    // 3. Adjacent Fifth (+1 or -1 on circle)
    const fifthMatch1 = keyService.evaluateCamelotRelationship('8A', '7A');
    const fifthMatch2 = keyService.evaluateCamelotRelationship('8A', '9A');
    assert(fifthMatch1.relationship === 'ADJACENT_FIFTH', 'Adjacent fifth -1 identified (8A -> 7A)');
    assert(fifthMatch2.relationship === 'ADJACENT_FIFTH', 'Adjacent fifth +1 identified (8A -> 9A)');
    assert(fifthMatch1.score === 0.90, 'Adjacent fifth returns compatibility 0.90');

    // 4. Wrap-around 12 to 1 on circle
    const wrapMatch = keyService.evaluateCamelotRelationship('12B', '1B');
    assert(wrapMatch.relationship === 'ADJACENT_FIFTH', 'Wrap-around circle edge handled (12B -> 1B)');
    assert(wrapMatch.score === 0.90, 'Wrap-around returns compatibility 0.90');

    // 5. Diagonal adjacent relative (e.g., 8A -> 9B or 7B)
    const diagonalMatch = keyService.evaluateCamelotRelationship('8A', '9B');
    assert(diagonalMatch.relationship === 'DIAGONAL', 'Diagonal relative identified (8A -> 9B)');
    assert(diagonalMatch.score === 0.80, 'Diagonal returns compatibility 0.80');

    // 6. Modulation (+/- 2 hours on circle)
    const modMatch = keyService.evaluateCamelotRelationship('8A', '10A');
    assert(modMatch.relationship === 'MODULATION', 'Harmonic modulation identified (8A -> 10A)');
    assert(modMatch.score === 0.70, 'Modulation returns compatibility 0.70');

    // 7. Incompatible keys
    const incompMatch = keyService.evaluateCamelotRelationship('8A', '2A');
    assert(incompMatch.relationship === 'INCOMPATIBLE', 'Distant key identified as INCOMPATIBLE (8A -> 2A)');
    assert(incompMatch.score <= 0.40, 'Incompatible returns baseline <= 0.40');

    // 8. Low Confidence Fallback in evaluate()
    const lowConfEval = keyService.evaluate('Am', 'D#m', 0.4, true);
    assert(lowConfEval.pitchShiftSemitones === 0, 'Low confidence (<0.55) suppresses pitch shifting');
    assert(lowConfEval.shiftApplied === false, 'Shift applied is false under low confidence');
  }

  // ─────────────────────────────────────────────────────────────────
  // SUITE 3: Micro Pitch Shifting Recommendations
  // ─────────────────────────────────────────────────────────────────
  console.log('\n--- SUITE 3: Micro Pitch Shifting Logic ---');
  {
    const keyService = new KeyCompatibilityService();

    // Already naturally compatible (score >= 0.85): shift MUST be 0
    const naturallyCompatible = keyService.evaluate('Am', 'C', 0.9, true);
    assert(naturallyCompatible.pitchShiftSemitones === 0, 'Does not shift naturally compatible tracks (Am -> C)');
    assert(naturallyCompatible.relationship === 'RELATIVE_MAJOR_MINOR', 'Maintains natural relationship');

    // Incompatible key where +1 semitone reaches harmony
    // Outgoing: Am (8A). Incoming: Abm (1A). +1 semitone -> Am (8A)!
    const pitchShiftSuggestion = keyService.evaluate('Am', 'Abm', 0.9, true);
    assert(
      pitchShiftSuggestion.pitchShiftSemitones === 1 || pitchShiftSuggestion.pitchShiftSemitones === -1,
      'Finds beneficial micro pitch shift (±1 semitone)',
    );
    assert(pitchShiftSuggestion.shiftApplied === true, 'Sets shiftApplied to true when shift is beneficial');
    assert(pitchShiftSuggestion.compatibilityScore > 0.8, 'Shift materially improves harmonic score');

    // When pitch shifting is disabled in FFmpeg: shift MUST be 0
    const disabledShift = keyService.evaluate('Am', 'Abm', 0.9, false);
    assert(disabledShift.pitchShiftSemitones === 0, 'Suppresses pitch shift when allowPitchShift is false');
    assert(disabledShift.shiftApplied === false, 'shiftApplied is false when pitch shift disabled');
  }

  // ─────────────────────────────────────────────────────────────────
  // SUITE 4: CuePointService & Phrase-Aware Transitions
  // ─────────────────────────────────────────────────────────────────
  console.log('\n--- SUITE 4: CuePointService & Phrase Boundaries ---');
  {
    const cueService = new CuePointService();

    const sampleOutgoing: TrackTransitionFeatures = {
      trackId: 'out-1',
      featureVersion: 1,
      integratedLoudnessLufs: -14.0,
      loudnessRangeLu: 2.0,
      truePeakDbtp: -1.0,
      trackGainDb: 0.0,
      beatGrid: [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0, 6.5, 7.0, 7.5, 8.0, 8.5, 9.0, 9.5, 10.0],
      beatConfidence: 0.9,
      phraseBoundaries: { fourBeats: [2.0, 4.0, 6.0, 8.0, 10.0], eightBeats: [4.0, 8.0], sixteenBeats: [8.0] },
      introStart: 0,
      introEnd: 2.0,
      introEnergy: 0.8,
      outroStart: 6.0,
      outroEnd: 10.0,
      outroEnergy: 0.7,
      dropCandidates: [],
      key: 'C',
      keyConfidence: 0.9,
      camelotCode: '8B',
      structureConfidence: 0.85,
      analysisStatus: 'READY',
    };

    const sampleIncoming: TrackTransitionFeatures = {
      ...sampleOutgoing,
      trackId: 'in-1',
      introStart: 0,
      introEnd: 3.0,
    };

    // 1. High confidence phrase alignment
    const result = cueService.selectCuePoints({
      outgoingFeatures: sampleOutgoing,
      incomingFeatures: sampleIncoming,
      outgoingDuration: 10.0,
      incomingDuration: 10.0,
      requestedDurationSeconds: 6.0,
      profileConfig: TRANSITION_PROFILES.BALANCED,
    });

    assert(result.strategy === 'PHRASE_ALIGNED', 'High confidence track selects PHRASE_ALIGNED strategy');
    assert(result.score > 0.8, 'Phrase aligned strategy produces high cue confidence score');
    assert(result.outgoingCueSeconds <= 10.0, 'Outgoing cue point within track duration');
    assert(result.incomingCueSeconds >= 0.0, 'Incoming cue point non-negative');
    assert(result.durationSeconds > 0 && result.durationSeconds <= 8, 'Clamped duration within 1-8s');

    // 2. Safe clamping on short track
    const clampedShort = cueService.selectCuePoints({
      outgoingFeatures: sampleOutgoing,
      incomingFeatures: sampleIncoming,
      outgoingDuration: 4.0,
      incomingDuration: 4.0,
      requestedDurationSeconds: 6.0,
      profileConfig: TRANSITION_PROFILES.SMOOTH,
    });
    assert(clampedShort.durationSeconds <= 2.0, 'Clamps transition duration when track is short');

    // 3. Fallback to DURATION_FALLBACK when beat grid is missing
    const unanalyzedOut: TrackTransitionFeatures = {
      ...sampleOutgoing,
      beatConfidence: 0.2, // low confidence
      beatGrid: [],
      phraseBoundaries: { fourBeats: [], eightBeats: [], sixteenBeats: [] },
    };
    const fallbackCue = cueService.selectCuePoints({
      outgoingFeatures: unanalyzedOut,
      incomingFeatures: sampleIncoming,
      outgoingDuration: 100.0,
      incomingDuration: 100.0,
      requestedDurationSeconds: 6.0,
      profileConfig: TRANSITION_PROFILES.BALANCED,
    });
    assert(fallbackCue.strategy === 'DURATION_FALLBACK', 'Falls back to DURATION_FALLBACK on low confidence beat data');
    assert(fallbackCue.outgoingCueSeconds === 94.0, 'Outgoing cue set to trackDuration - preferredDuration');
  }

  // ─────────────────────────────────────────────────────────────────
  // SUITE 5: TransitionEngine Profile Planning & Clamping
  // ─────────────────────────────────────────────────────────────────
  console.log('\n--- SUITE 5: TransitionEngine Profiles & Tempo Clamping ---');
  {
    const engine = new TransitionEngine();

    const baseFeatures: TrackTransitionFeatures = {
      trackId: 't-1',
      featureVersion: 1,
      integratedLoudnessLufs: -14.0,
      loudnessRangeLu: 2.0,
      truePeakDbtp: -1.0,
      trackGainDb: 0.0,
      beatGrid: [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0, 6.5, 7.0, 7.5, 8.0, 8.5, 9.0, 9.5, 10.0, 10.5, 11.0, 11.5, 12.0],
      beatConfidence: 0.9,
      phraseBoundaries: { fourBeats: [2.0, 4.0, 6.0, 8.0, 10.0], eightBeats: [4.0, 8.0], sixteenBeats: [8.0] },
      introStart: 0,
      introEnd: 2.0,
      introEnergy: 0.8,
      outroStart: 8.0,
      outroEnd: 12.0,
      outroEnergy: 0.7,
      dropCandidates: [],
      key: 'C',
      keyConfidence: 0.9,
      camelotCode: '8B',
      structureConfidence: 0.85,
      analysisStatus: 'READY',
    };

    // 1. SMOOTH profile
    const smoothPlan = engine.planTransition({
      guildId: 'g-1',
      fromTrackId: 't-1',
      toTrackId: 't-2',
      fromTrackDuration: 12.0,
      toTrackDuration: 12.0,
      fromTrackBpm: 120,
      toTrackBpm: 122, // 1.67% delta <= 3% max
      fromFeatures: baseFeatures,
      toFeatures: { ...baseFeatures, trackId: 't-2', camelotCode: '9B' },
      settings: {
        transitionEnabled: true,
        transitionProfile: 'SMOOTH',
        harmonicMixing: true,
        autoTempo: true,
        loudnessNormalize: true,
      },
      rubberBandAvailable: true,
    });

    assert(smoothPlan.profile === 'SMOOTH', 'Plan retains SMOOTH profile');
    assert(smoothPlan.curve === 'qsin', 'SMOOTH profile uses equal-power qsin curve');
    assert(smoothPlan.fallbackLevel === 'ADVANCED', 'Selects ADVANCED level with rubberband available');
    assert(Math.abs(smoothPlan.tempoAdjustmentPercent - 1.639) < 0.1, 'Calculates tempo stretch ratio correctly');

    // 2. ENERGETIC profile
    const energeticPlan = engine.planTransition({
      guildId: 'g-1',
      fromTrackId: 't-1',
      toTrackId: 't-2',
      fromTrackDuration: 12.0,
      toTrackDuration: 12.0,
      fromTrackBpm: 120,
      toTrackBpm: 120,
      fromFeatures: baseFeatures,
      toFeatures: baseFeatures,
      settings: {
        transitionEnabled: true,
        transitionProfile: 'ENERGETIC',
        harmonicMixing: true,
        autoTempo: true,
        loudnessNormalize: true,
      },
      rubberBandAvailable: true,
    });

    assert(energeticPlan.profile === 'ENERGETIC', 'Plan retains ENERGETIC profile');
    assert(energeticPlan.curve === 'hsin', 'ENERGETIC profile uses snappy hsin curve');
    assert(energeticPlan.durationSeconds <= 4.0, 'ENERGETIC profile prefers shorter transition (3-4s)');

    // 3. Tempo Clamping (> 3% threshold ignored)
    const largeBpmPlan = engine.planTransition({
      guildId: 'g-1',
      fromTrackId: 't-1',
      toTrackId: 't-2',
      fromTrackDuration: 12.0,
      toTrackDuration: 12.0,
      fromTrackBpm: 120,
      toTrackBpm: 135, // 12.5% delta > 3% threshold!
      fromFeatures: baseFeatures,
      toFeatures: baseFeatures,
      settings: {
        transitionEnabled: true,
        transitionProfile: 'BALANCED',
        harmonicMixing: true,
        autoTempo: true,
        loudnessNormalize: true,
      },
      rubberBandAvailable: true,
    });

    assert(largeBpmPlan.tempoAdjustmentPercent === 0, 'Rejects tempo adjustment when delta exceeds 3%');
  }

  // ─────────────────────────────────────────────────────────────────
  // SUITE 6: Graceful Fallback Ladder
  // ─────────────────────────────────────────────────────────────────
  console.log('\n--- SUITE 6: Fallback Ladder Progression ---');
  {
    const engine = new TransitionEngine();

    const baseFeatures: TrackTransitionFeatures = {
      trackId: 't-1',
      featureVersion: 1,
      integratedLoudnessLufs: -14.0,
      loudnessRangeLu: 2.0,
      truePeakDbtp: -1.0,
      trackGainDb: 0.0,
      beatGrid: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      beatConfidence: 0.9,
      phraseBoundaries: { fourBeats: [4, 8], eightBeats: [8], sixteenBeats: [] },
      introStart: 0,
      introEnd: 2.0,
      introEnergy: 0.8,
      outroStart: 6.0,
      outroEnd: 10.0,
      outroEnergy: 0.7,
      dropCandidates: [],
      key: 'C',
      keyConfidence: 0.9,
      camelotCode: '8B',
      structureConfidence: 0.85,
      analysisStatus: 'READY',
    };

    // Case A: rubberband unavailable -> falls back from ADVANCED to CROSSFADE
    const noRubberBandPlan = engine.planTransition({
      guildId: 'g-1',
      fromTrackId: 't-1',
      toTrackId: 't-2',
      fromTrackDuration: 10.0,
      toTrackDuration: 10.0,
      fromTrackBpm: 120,
      toTrackBpm: 122,
      fromFeatures: baseFeatures,
      toFeatures: baseFeatures,
      settings: {
        transitionEnabled: true,
        transitionProfile: 'BALANCED',
        harmonicMixing: true,
        autoTempo: true,
        loudnessNormalize: true,
      },
      rubberBandAvailable: false, // Simulated unavailable
    });

    assert(noRubberBandPlan.fallbackLevel === 'CROSSFADE', 'Falls back to CROSSFADE when rubberband is missing');
    assert(noRubberBandPlan.durationSeconds > 0, 'Maintains crossfade duration even without advanced DSP');

    // Case B: transitions disabled in guild settings -> falls back to HARD_CUT
    const disabledPlan = engine.planTransition({
      guildId: 'g-1',
      fromTrackId: 't-1',
      toTrackId: 't-2',
      fromTrackDuration: 10.0,
      toTrackDuration: 10.0,
      fromTrackBpm: 120,
      toTrackBpm: 120,
      settings: {
        transitionEnabled: false, // Disabled
        transitionProfile: 'BALANCED',
        harmonicMixing: false,
        autoTempo: false,
        loudnessNormalize: false,
      },
      rubberBandAvailable: true,
    });

    assert(disabledPlan.fallbackLevel === 'HARD_CUT', 'Settings disabled results in safe HARD_CUT');
    assert(disabledPlan.durationSeconds === 0, 'HARD_CUT duration is 0 seconds');

    // Case C: Short track (< 5 seconds) -> falls back to HARD_CUT
    const shortTrackPlan = engine.planTransition({
      guildId: 'g-1',
      fromTrackId: 't-1',
      toTrackId: 't-2',
      fromTrackDuration: 3.5, // 3.5s track
      toTrackDuration: 10.0,
      settings: {
        transitionEnabled: true,
        transitionProfile: 'BALANCED',
        harmonicMixing: true,
        autoTempo: true,
        loudnessNormalize: true,
      },
      rubberBandAvailable: true,
    });

    assert(shortTrackPlan.fallbackLevel === 'HARD_CUT', 'Short track (<5s) triggers HARD_CUT guard');
  }

  // ─────────────────────────────────────────────────────────────────
  // SUITE 7: EBU R128 Loudness Normalization & Volume Independence
  // ─────────────────────────────────────────────────────────────────
  console.log('\n--- SUITE 7: Loudness Normalization & Gain Protection ---');
  {
    const engine = new TransitionEngine();

    const quietTrack: TrackTransitionFeatures = {
      trackId: 'quiet-1',
      featureVersion: 1,
      integratedLoudnessLufs: -28.0, // Quiet
      loudnessRangeLu: 2.0,
      truePeakDbtp: -1.0,
      trackGainDb: 14.0, // Target -14: gain = -14 - (-28) = +14 dB
      beatGrid: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      beatConfidence: 0.9,
      phraseBoundaries: { fourBeats: [4, 8], eightBeats: [8], sixteenBeats: [] },
      introStart: 0,
      introEnd: 1,
      introEnergy: 0.5,
      outroStart: 8,
      outroEnd: 10,
      outroEnergy: 0.5,
      dropCandidates: [],
      key: 'C',
      keyConfidence: 0.9,
      camelotCode: '8B',
      structureConfidence: 0.9,
      analysisStatus: 'READY',
    };

    const loudTrack: TrackTransitionFeatures = {
      ...quietTrack,
      trackId: 'loud-1',
      integratedLoudnessLufs: -6.0, // Loud
      trackGainDb: -8.0, // Target -14: gain = -14 - (-6) = -8 dB
    };

    const plan = engine.planTransition({
      guildId: 'g-1',
      fromTrackId: 'quiet-1',
      toTrackId: 'loud-1',
      fromTrackDuration: 10.0,
      toTrackDuration: 10.0,
      fromFeatures: quietTrack,
      toFeatures: loudTrack,
      settings: {
        transitionEnabled: true,
        transitionProfile: 'BALANCED',
        harmonicMixing: true,
        autoTempo: true,
        loudnessNormalize: true,
      },
      rubberBandAvailable: true,
    });

    assert(plan.fromTrackGainDb === 14.0, 'Applies +14dB gain to quiet outgoing track');
    assert(plan.toTrackGainDb === -8.0, 'Applies -8dB gain to loud incoming track');
    assert(plan.loudnessProfileApplied === true, 'Sets loudnessProfileApplied flag in plan');
  }

  // ─────────────────────────────────────────────────────────────────
  // SUITE 8: PlaybackManager Lookahead Preparation & Skip Behavior
  // ─────────────────────────────────────────────────────────────────
  console.log('\n--- SUITE 8: PlaybackManager Lookahead Preparation ---');
  {
    const guildId = 'phase8-guild-lookahead';
    const queueManager = new QueueManager(logger);
    const mockAdapter = new Phase8MockVoiceAdapter();
    const playbackManager = new PlaybackManager(logger, queueManager);
    playbackManager.registerAdapter(mockAdapter);

    playbackManager.setTransitionRenderer({
      renderTransitionStream: async () => {
        const { PassThrough } = await import('node:stream');
        const pt = new PassThrough();
        pt.end(Buffer.alloc(100));
        return { stream: pt as any, process: null as any, effectiveFallback: 'ADVANCED' };
      },
    });

    // Configure transition settings
    playbackManager.setTransitionSettings(guildId, {
      transitionEnabled: true,
      transitionDuration: 6,
      transitionProfile: 'SMOOTH',
    });

    const settings = playbackManager.getTransitionSettings(guildId);
    assert(settings.transitionEnabled === true, 'Transition enabled in guild settings');
    assert(settings.transitionDuration === 6, 'Transition duration stored (6s)');
    assert(settings.transitionProfile === 'SMOOTH', 'Transition profile stored (SMOOTH)');

    const testAudioPath = path.resolve(process.cwd(), 'storage', 'evaluation', 'chill_ambient_60bpm.wav');

    // Start Track 1
    const source1 = new MockAudioSource(testAudioPath, 'Track 1', 120);
    await playbackManager.play(guildId, source1, {
      name: 'Track 1',
      path: testAudioPath,
      duration: 120,
    });
    assert(mockAdapter.getCurrentTrack(guildId)?.name === 'Track 1', 'Track 1 starts playing');

    // Add Track 2 to queue
    queueManager.addTrack(guildId, {
      id: 'q2',
      name: 'Track 2',
      path: testAudioPath,
      duration: 120,
    });

    let prepared = playbackManager.getPreparedTransition(guildId);
    assert(prepared === null, 'Initially no prepared transition');

    // Trigger lookahead preparation
    const plan = await playbackManager.prepareNextTrackTransition(guildId);
    assert(plan !== null, 'Prepares next track transition before current track reaches completion');

    prepared = playbackManager.getPreparedTransition(guildId);
    assert(prepared !== null, 'getPreparedTransition returns prepared transition state');
    assert(prepared?.nextTrack.name === 'Track 2', 'Prepared transition targets next queue track');

    // Immediate Skip Override
    const skipped = await playbackManager.skip(guildId);
    assert(skipped.skipped === true, 'Manual skip succeeds immediately without waiting for crossfade');
    assert(skipped.nowPlaying?.name === 'Track 2', 'Now playing advances immediately to Track 2 on manual skip');
    assert(playbackManager.getPreparedTransition(guildId) === null, 'Prepared transition cleared on manual skip');

    // Clean up
    await playbackManager.stop(guildId);
  }

  // ─────────────────────────────────────────────────────────────────
  // SUITE 9: Loop Mode Compatibility (Track vs Queue)
  // ─────────────────────────────────────────────────────────────────
  console.log('\n--- SUITE 9: Loop Mode Compatibility ---');
  {
    const guildId = 'phase8-guild-loop';
    const queueManager = new QueueManager(logger);
    const mockAdapter = new Phase8MockVoiceAdapter();
    const playbackManager = new PlaybackManager(logger, queueManager);
    playbackManager.registerAdapter(mockAdapter);

    playbackManager.setTransitionRenderer({
      renderTransitionStream: async () => {
        const { PassThrough } = await import('node:stream');
        const pt = new PassThrough();
        pt.end(Buffer.alloc(100));
        return { stream: pt as any, process: null as any, effectiveFallback: 'ADVANCED' };
      },
    });

    playbackManager.setTransitionSettings(guildId, {
      transitionEnabled: true,
      transitionDuration: 4,
    });

    const testAudioPath = path.resolve(process.cwd(), 'storage', 'evaluation', 'chill_ambient_60bpm.wav');
    const sourceA = new MockAudioSource(testAudioPath, 'Track A', 100);
    await playbackManager.play(guildId, sourceA, {
      name: 'Track A',
      path: testAudioPath,
      duration: 100,
    });

    queueManager.addTrack(guildId, {
      id: 'track-b',
      name: 'Track B',
      path: testAudioPath,
      duration: 100,
    });

    // Test loop mode TRACK
    playbackManager.setLoopMode(guildId, 'track');
    const trackLoopPlan = await playbackManager.prepareNextTrackTransition(guildId);
    assert(trackLoopPlan === null, 'Loop TRACK mode does not crossfade into itself');

    // Test loop mode QUEUE
    playbackManager.setLoopMode(guildId, 'queue');
    const queueLoopPlan = await playbackManager.prepareNextTrackTransition(guildId);
    assert(queueLoopPlan !== null, 'Loop QUEUE mode prepares seamless transition between tracks');

    await playbackManager.stop(guildId);
  }

  // ─────────────────────────────────────────────────────────────────
  // SUITE 10: Slash Command Handling & Parameter Validation
  // ─────────────────────────────────────────────────────────────────
  console.log('\n--- SUITE 10: Slash Commands & Validation ---');
  {
    const guildId = 'phase8-guild-commands';
    const queueManager = new QueueManager(logger);
    const mockAdapter = new Phase8MockVoiceAdapter();
    const playbackManager = new PlaybackManager(logger, queueManager);
    playbackManager.registerAdapter(mockAdapter);

    // 1. /transition on
    let onReply = '';
    const mockOnInteraction: any = {
      commandName: 'transition',
      guildId,
      user: { id: 'u-1', username: 'DjUser' },
      options: {
        getSubcommand: () => 'on',
      },
      reply: async (msg: any) => { onReply = typeof msg === 'string' ? msg : msg.content; },
    };

    await handleChatInputCommand(mockOnInteraction, playbackManager);
    assert(onReply.includes('DJ Transitions are now **ENABLED**'), '/transition on confirms activation');
    assert(playbackManager.getTransitionSettings(guildId).transitionEnabled === true, 'Guild state updated to enabled');

    // 2. /transition duration 6
    let durReply = '';
    const mockDurInteraction: any = {
      commandName: 'transition',
      guildId,
      user: { id: 'u-1', username: 'DjUser' },
      options: {
        getSubcommand: () => 'duration',
        getInteger: (_name: string) => 6,
      },
      reply: async (msg: any) => { durReply = typeof msg === 'string' ? msg : msg.content; },
    };

    await handleChatInputCommand(mockDurInteraction, playbackManager);
    assert(durReply.includes('crossfade duration set to **6s**'), '/transition duration confirms 6s setting');
    assert(playbackManager.getTransitionSettings(guildId).transitionDuration === 6, 'Duration setting persisted');

    // 3. /transition duration 12 (Out of range validation: 1-8 allowed)
    let errReply = '';
    const mockInvalidDurInteraction: any = {
      commandName: 'transition',
      guildId,
      user: { id: 'u-1', username: 'DjUser' },
      options: {
        getSubcommand: () => 'duration',
        getInteger: (_name: string) => 12, // Invalid!
      },
      reply: async (msg: any) => { errReply = typeof msg === 'string' ? msg : msg.content; },
    };

    await handleChatInputCommand(mockInvalidDurInteraction, playbackManager);
    assert(errReply.includes('Duration must be between 1 and 8 seconds'), '/transition rejects durations outside 1-8s');

    // 4. /transition profile energetic
    let profReply = '';
    const mockProfInteraction: any = {
      commandName: 'transition',
      guildId,
      user: { id: 'u-1', username: 'DjUser' },
      options: {
        getSubcommand: () => 'profile',
        getString: (_name: string) => 'energetic',
      },
      reply: async (msg: any) => { profReply = typeof msg === 'string' ? msg : msg.content; },
    };

    await handleChatInputCommand(mockProfInteraction, playbackManager);
    assert(profReply.includes('transition profile set to **ENERGETIC**'), '/transition profile confirms ENERGETIC');
    assert(playbackManager.getTransitionSettings(guildId).transitionProfile === 'ENERGETIC', 'Profile setting persisted');

    // 5. /transition off
    let offReply = '';
    const mockOffInteraction: any = {
      commandName: 'transition',
      guildId,
      user: { id: 'u-1', username: 'DjUser' },
      options: {
        getSubcommand: () => 'off',
      },
      reply: async (msg: any) => { offReply = typeof msg === 'string' ? msg : msg.content; },
    };

    await handleChatInputCommand(mockOffInteraction, playbackManager);
    assert(offReply.includes('DJ Transitions are now **DISABLED**'), '/transition off confirms deactivation');
    assert(playbackManager.getTransitionSettings(guildId).transitionEnabled === false, 'Guild state updated to disabled');
  }

  // ─────────────────────────────────────────────────────────────────
  // SUITE 11: Physical Audio DSP & TransitionProcessor FilterGraph
  // ─────────────────────────────────────────────────────────────────
  console.log('\n--- SUITE 11: TransitionProcessor FilterGraph & DSP ---');
  {
    const processor = new TransitionProcessor();
    const caps = await detectFFmpegCapabilities();

    const plan: TransitionPlan = {
      id: 'plan-test-1',
      guildId: 'g-1',
      fromTrackId: 't-1',
      toTrackId: 't-2',
      fallbackLevel: 'ADVANCED',
      profile: 'BALANCED',
      durationSeconds: 5,
      curve: 'qsin',
      overlap: true,
      outgoingCueSeconds: 10,
      incomingCueSeconds: 0,
      tempoAdjustmentPercent: 1.5,
      pitchShiftSemitones: 0,
      fromTrackGainDb: -2.0,
      toTrackGainDb: 1.0,
      algorithmVersion: 'v1',
      score: 0.9,
      explanation: 'Balanced test transition',
    };

    const graph = processor.buildFilterGraph(plan, caps, 'ADVANCED');
    assert(graph.mapOutput === '[out]', 'FilterGraph maps to [out]');
    assert(graph.filterComplex.includes('acrossfade=d=5:c1=qsin:c2=qsin:o=1'), 'FilterGraph uses equal-power acrossfade curve');
    assert(graph.filterComplex.includes('volume=-2.00dB'), 'FilterGraph includes outgoing track gain');
    assert(graph.filterComplex.includes('volume=1.00dB'), 'FilterGraph includes incoming track gain');

    if (caps.rubberband) {
      assert(graph.filterComplex.includes('rubberband='), 'FilterGraph uses rubberband for pitch-preserving tempo stretch');
    }

    // Verify SIMPLE_FADE filter
    const simpleGraph = processor.buildFilterGraph(plan, caps, 'SIMPLE_FADE');
    assert(simpleGraph.filterComplex.includes('afade=t=out'), 'SIMPLE_FADE includes afade out');
    assert(simpleGraph.filterComplex.includes('afade=t=in'), 'SIMPLE_FADE includes afade in');

    // Verify HARD_CUT filter
    const hardCutGraph = processor.buildFilterGraph(plan, caps, 'HARD_CUT');
    assert(hardCutGraph.filterComplex.includes('concat=n=2'), 'HARD_CUT filter concatenates streams seamlessly');
  }

  // ── Test Summary ─────────────────────────────────────────────────
  console.log('\n======================================================');
  console.log(`   PHASE 8 TEST RESULTS: ${passedTests}/${totalTests} PASSED (${failedTests} FAILED)`);
  console.log('======================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runPhase8Tests().catch((err) => {
  console.error('Fatal error during Phase 8 test execution:', err);
  process.exit(1);
});
