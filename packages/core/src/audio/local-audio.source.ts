import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Readable } from 'node:stream';
import { AudioSource } from './audio-source';
import type { AudioMetadata } from '../types/audio';
import {
  FileNotFoundError,
  UnsupportedAudioFormatError,
  AudioFileEmptyError,
} from './errors';

export const SUPPORTED_AUDIO_EXTENSIONS = [
  '.mp3',
  '.wav',
  '.ogg',
  '.flac',
  '.m4a',
  '.aac',
  '.opus',
];

/** Function type for metadata probe providers (such as FFmpeg) */
export type MetadataProbeFunction = (filePath: string) => Promise<Partial<AudioMetadata>>;

/**
 * Locate the storage/music directory by searching upwards from current working directory.
 */
export function resolveMusicStorageDir(startDir: string = process.cwd()): string {
  let curr = startDir;
  while (curr !== path.dirname(curr)) {
    const candidate = path.join(curr, 'storage', 'music');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    curr = path.dirname(curr);
  }
  return path.resolve(process.cwd(), 'storage/music');
}

/**
 * Local file audio source.
 *
 * Encapsulates validation and reading of local audio files
 * stored on the server filesystem.
 */
export class LocalAudioSource extends AudioSource {
  readonly sourceType = 'local' as const;
  readonly identifier: string;
  readonly resolvedPath: string;

  private metadata: AudioMetadata | null = null;
  private probeFn?: MetadataProbeFunction;

  /**
   * @param inputPath - File name or path (e.g. 'test.mp3', 'storage/music/test.mp3')
   * @param baseDir - Base storage directory for relative paths (defaults to auto-detected storage/music)
   * @param probeFn - Optional metadata probe function
   */
  constructor(
    inputPath: string,
    baseDir: string = resolveMusicStorageDir(),
    probeFn?: MetadataProbeFunction,
  ) {
    super();
    this.identifier = inputPath;
    this.probeFn = probeFn;

    if (path.isAbsolute(inputPath)) {
      this.resolvedPath = path.normalize(inputPath);
    } else {
      if (inputPath.startsWith('storage') || inputPath.startsWith('.')) {
        const rootDir = path.dirname(baseDir);
        const candidate1 = path.resolve(rootDir, inputPath);
        const candidate2 = path.resolve(process.cwd(), inputPath);
        this.resolvedPath = fs.existsSync(candidate1) ? candidate1 : candidate2;
      } else {
        this.resolvedPath = path.resolve(baseDir, inputPath);
      }
    }
  }

  /**
   * Validate that the file exists, has a supported audio extension, and is not empty.
   */
  async validate(): Promise<void> {
    if (!fs.existsSync(this.resolvedPath)) {
      throw new FileNotFoundError(this.identifier);
    }

    const stat = await fs.promises.stat(this.resolvedPath);
    if (!stat.isFile()) {
      throw new FileNotFoundError(this.identifier);
    }

    const ext = path.extname(this.resolvedPath).toLowerCase();
    if (!SUPPORTED_AUDIO_EXTENSIONS.includes(ext)) {
      throw new UnsupportedAudioFormatError(ext, SUPPORTED_AUDIO_EXTENSIONS);
    }

    if (stat.size === 0) {
      throw new AudioFileEmptyError(this.resolvedPath);
    }
  }

  /**
   * Retrieve audio metadata. If a probe function was supplied, executes it;
   * otherwise defaults title to file name without extension.
   */
  async getMetadata(): Promise<AudioMetadata> {
    if (this.metadata) {
      return this.metadata;
    }

    await this.validate();

    const fileName = path.basename(this.resolvedPath, path.extname(this.resolvedPath));
    let probed: Partial<AudioMetadata> = {};

    if (this.probeFn) {
      try {
        probed = await this.probeFn(this.resolvedPath);
      } catch {
        // Fallback to basic filename metadata on probe error
      }
    }

    this.metadata = {
      title: probed.title || fileName,
      artist: probed.artist || null,
      album: probed.album || null,
      duration: probed.duration !== undefined ? probed.duration : null,
    };

    return this.metadata;
  }

  /**
   * Create a readable stream for this local file.
   */
  getStream(): Readable {
    return fs.createReadStream(this.resolvedPath);
  }
}
