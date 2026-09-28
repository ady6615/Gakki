import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../../utils/logger';
import type {
  TranscriptionProvider,
  TranscriptionOptions,
  TranscriptResult,
  TranscriptSegmentResult,
} from '../transcription.interface';

const execAsync = promisify(exec);
const logger = createLogger('whisper-local-provider');

/**
 * WhisperLocalProvider attempts local speech-to-text using local Whisper CLI or python model.
 * If local whisper executable is unavailable, reports isAvailable() = false.
 */
export class WhisperLocalProvider implements TranscriptionProvider {
  public readonly name = 'whisper-local';
  private binaryPath: string | null = null;
  private checked = false;

  async isAvailable(): Promise<boolean> {
    if (this.checked) return this.binaryPath !== null;
    this.checked = true;

    // Check environment variable or standard binaries
    const candidateBinaries = [process.env.WHISPER_PATH, 'whisper', 'whisper-cli', 'whisper-cpp'];

    for (const bin of candidateBinaries) {
      if (!bin) continue;
      try {
        await execAsync(`"${bin}" --help`);
        this.binaryPath = bin;
        logger.info({ binary: bin }, '[TRANSCRIPTION] Discovered local Whisper binary');
        return true;
      } catch {
        // Not found, continue
      }
    }

    logger.debug('[TRANSCRIPTION] Local Whisper binary not found in PATH');
    return false;
  }

  async transcribe(
    audioFilePath: string,
    options?: TranscriptionOptions
  ): Promise<TranscriptResult> {
    const available = await this.isAvailable();
    if (!available || !this.binaryPath) {
      throw new Error('Local Whisper engine is not available on this host');
    }

    const model = options?.model || process.env.WHISPER_MODEL || 'base';
    const language = options?.language || 'en';
    const outputDir = path.dirname(audioFilePath);

    const cmd = `"${this.binaryPath}" "${audioFilePath}" --model ${model} --language ${language} --output_format json --output_dir "${outputDir}"`;
    logger.info({ cmd }, '[TRANSCRIPTION] Executing local Whisper job');

    await execAsync(cmd);

    const baseName = path.basename(audioFilePath, path.extname(audioFilePath));
    const jsonPath = path.join(outputDir, `${baseName}.json`);

    if (!fs.existsSync(jsonPath)) {
      throw new Error(`Whisper completed but expected output file was not found: ${jsonPath}`);
    }

    const outputData = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    const segments: TranscriptSegmentResult[] = (outputData.segments || []).map(
      (s: any, idx: number) => ({
        speakerId: null,
        speakerName: `Speaker ${(idx % 2) + 1}`,
        startMs: Math.round(s.start * 1000),
        endMs: Math.round(s.end * 1000),
        text: s.text.trim(),
        confidence: s.confidence ?? 0.95,
      })
    );

    return {
      provider: this.name,
      model,
      language,
      fullText: outputData.text?.trim() || segments.map((s) => s.text).join(' '),
      segments,
    };
  }
}
