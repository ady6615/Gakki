import type {
  TranscriptionProvider,
  TranscriptionOptions,
  TranscriptResult,
  TranscriptSegmentResult,
} from '../transcription.interface';

/**
 * MockTranscriptionProvider produces deterministic, realistic timestamped transcripts
 * for unit testing, offline environments, and fallback when local whisper models are not present.
 */
export class MockTranscriptionProvider implements TranscriptionProvider {
  public readonly name = 'mock-transcription';

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async transcribe(
    _audioFilePath: string,
    options?: TranscriptionOptions
  ): Promise<TranscriptResult> {
    const participants = options?.participants || [];
    const language = options?.language || 'en';

    const p0 = participants[0] || { userId: 'usr_speaker_1', displayName: 'Speaker 1' };
    const p1 = participants[1] || { userId: 'usr_speaker_2', displayName: 'Speaker 2' };

    const segments: TranscriptSegmentResult[] = [
      {
        speakerId: p0.userId,
        speakerName: p0.displayName,
        startMs: 1200,
        endMs: 4500,
        text: 'Welcome everyone, let us begin the session recording and discussion.',
        confidence: 0.98,
      },
      {
        speakerId: p1.userId,
        speakerName: p1.displayName,
        startMs: 5100,
        endMs: 8900,
        text: 'Sounds great. I have reviewed the database migration and architecture requirements.',
        confidence: 0.96,
      },
      {
        speakerId: p0.userId,
        speakerName: p0.displayName,
        startMs: 9500,
        endMs: 14200,
        text: 'Excellent. The voice recording mixer preserves multi-participant synchronization.',
        confidence: 0.99,
      },
      {
        speakerId: p1.userId,
        speakerName: p1.displayName,
        startMs: 14800,
        endMs: 18400,
        text: 'And transcription indexing enables fast clickable timestamp seeks.',
        confidence: 0.97,
      },
      {
        speakerId: p0.userId,
        speakerName: p0.displayName,
        startMs: 19000,
        endMs: 22100,
        text: 'Agreed. Everything looks solid for production hardening.',
        confidence: 0.99,
      },
    ];

    const fullText = segments.map((s) => `${s.speakerName}: ${s.text}`).join('\n\n');

    return {
      provider: this.name,
      model: options?.model || 'whisper-base.mock',
      language,
      fullText,
      segments,
    };
  }
}
