export interface TranscriptionOptions {
  language?: string;
  model?: string;
  prompt?: string;
  participants?: Array<{
    userId: string;
    displayName: string;
    firstAudioMs?: number;
    audioFilePath?: string;
  }>;
}

export interface TranscriptSegmentResult {
  speakerId?: string | null;
  speakerName: string;
  startMs: number;
  endMs: number;
  text: string;
  confidence: number;
}

export interface TranscriptResult {
  provider: string;
  model: string;
  language: string;
  fullText: string;
  segments: TranscriptSegmentResult[];
}

export interface TranscriptionProvider {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  transcribe(audioFilePath: string, options?: TranscriptionOptions): Promise<TranscriptResult>;
}
