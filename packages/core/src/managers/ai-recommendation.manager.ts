/**
 * AI-powered music recommendation engine.
 *
 * NOT IMPLEMENTED — This is a future module.
 *
 * Planned capabilities:
 * - Smart shuffle using listening history and audio similarity
 * - "Vibe playlists" generated from audio embeddings (pgvector)
 * - Mood-based recommendations
 * - Will likely interface with a separate Python service
 *   running librosa/Essentia for audio feature extraction
 *
 * This stub exists to establish the module's place in the architecture.
 * All methods will throw until the AI service is built.
 */
export class AiRecommendationManager {
  /** @throws Always — module not yet implemented */
  getRecommendations(): never {
    throw new Error('AiRecommendationManager is not implemented. This module requires the AI audio analysis service.');
  }
}
