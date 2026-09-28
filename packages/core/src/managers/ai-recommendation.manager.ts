import type { DatabaseClient } from '../database/connection';
import type { Logger } from 'pino';
import { createLogger } from '../utils/logger';
import { AudioFeatureManager } from './audio-feature.manager';
import { TrackSimilarityService } from './track-similarity.service';
import { PreferenceScoringService } from './preference-scoring.service';
import { DynamicDJManager, type DynamicDJContext } from './dynamic-dj.manager';
import type { TrackManager } from './track.manager';
import type { AnalyticsManager } from './analytics.manager';
import type { PlaylistManager } from './playlist.manager';
import type {
  AcousticFeatures,
  DJProfile,
  DJState,
  RecommendationCandidate,
  RecommendationResult,
} from '../types/recommendation';
import type { QueueTrack } from '../types/queue';

const defaultLogger = createLogger('ai-recommendation');

/**
 * Unified AI Recommendation & Dynamic DJ Manager facade.
 *
 * Coordinates:
 * - Audio feature extraction & pgvector storage (AudioFeatureManager)
 * - Measurable deterministic hybrid similarity (TrackSimilarityService)
 * - Implicit listening interaction preferences (PreferenceScoringService)
 * - Adaptive lookahead DJ & Smart Shuffle (DynamicDJManager)
 */
export class AiRecommendationManager {
  readonly featureManager: AudioFeatureManager;
  readonly similarityService: TrackSimilarityService;
  readonly preferenceService: PreferenceScoringService;
  readonly djManager: DynamicDJManager;

  constructor(
    db: DatabaseClient | null,
    trackManager: TrackManager,
    analyticsManager: AnalyticsManager,
    playlistManager?: PlaylistManager,
    options: { recentCooldownCount?: number } = {},
    private readonly logger: Logger = defaultLogger,
  ) {
    this.featureManager = new AudioFeatureManager(db);
    this.similarityService = new TrackSimilarityService(this.logger);
    this.preferenceService = new PreferenceScoringService(analyticsManager, playlistManager, this.logger);
    this.djManager = new DynamicDJManager(
      this.featureManager,
      this.similarityService,
      this.preferenceService,
      trackManager,
      options,
      this.logger,
    );

    this.logger.debug('AiRecommendationManager initialized');
  }

  /**
   * Find tracks acoustically and rhythmically similar to a seed track.
   */
  async getSimilarTracks(
    seedTrackId: string,
    limit: number = 10,
    profile: DJProfile = 'BALANCED',
  ): Promise<RecommendationCandidate[]> {
    const seedFeatures = await this.featureManager.getFeatures(seedTrackId);
    if (!seedFeatures) {
      return [];
    }

    const readyTracks = await this.featureManager.getAllReadyFeatures();
    const candidates = readyTracks
      .filter((r) => r.trackId !== seedTrackId)
      .map((r) => ({
        trackId: r.trackId,
        title: `Track ${r.trackId.slice(0, 8)}`,
        artist: null,
        features: r.features,
      }));

    return this.similarityService.findSimilarTracks(seedFeatures, candidates, limit, profile);
  }

  /**
   * Generate a "Same Vibe" playlist starting from a seed track.
   */
  async generateVibePlaylist(
    seedTrackId: string,
    guildId: string,
    limit: number = 10,
    profile: DJProfile = 'BALANCED',
  ): Promise<RecommendationResult> {
    return this.djManager.generateRecommendations({
      guildId,
      seedTrackId,
      limit,
      profile,
    });
  }

  /**
   * Smart shuffle a queue with acoustic continuity and controlled stochasticity.
   */
  async smartShuffle(
    guildId: string,
    queue: QueueTrack[],
    currentTrack?: QueueTrack | null,
    profile?: DJProfile,
  ): Promise<QueueTrack[]> {
    return this.djManager.smartShuffle(guildId, queue, currentTrack, profile);
  }

  /**
   * Configure DJ mode state for a guild.
   */
  configureDJ(guildId: string, options: { enabled?: boolean; profile?: DJProfile }): DJState {
    return this.djManager.configureDJ(guildId, options);
  }

  /**
   * Get current DJ state for a guild.
   */
  getDJState(guildId: string): DJState {
    return this.djManager.getDJState(guildId);
  }

  /**
   * Select next track via dynamic DJ pipeline.
   */
  async selectNextTrack(context: DynamicDJContext): Promise<RecommendationCandidate | null> {
    return this.djManager.selectNextTrack(context);
  }
}
