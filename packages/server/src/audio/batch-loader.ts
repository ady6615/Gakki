import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  SUPPORTED_AUDIO_EXTENSIONS,
  resolveMusicStorageDir,
  createLogger,
  type QueueTrack,
  type QueueManager,
} from '@gakki/core';
import { probeAudioMetadata } from './ffmpeg';

const logger = createLogger('batch-loader');

/**
 * Validate that a target path stays securely inside the configured music storage root.
 * Prevents directory traversal attacks (e.g. `../../etc/passwd`).
 */
export function secureResolveMusicPath(inputPath: string): {
  absolutePath: string;
  relativePath: string;
} {
  const baseDir = path.resolve(resolveMusicStorageDir());
  // Normalize input path and remove leading slashes/backslashes
  const cleanInput = path.normalize(inputPath).replace(/^(\/|\\)+/, '');

  let resolved: string;
  if (path.isAbsolute(inputPath)) {
    resolved = path.normalize(inputPath);
  } else if (cleanInput.startsWith('storage' + path.sep + 'music') || cleanInput.startsWith('storage/music')) {
    const rootDir = path.dirname(path.dirname(baseDir));
    resolved = path.resolve(rootDir, cleanInput);
  } else {
    resolved = path.resolve(baseDir, cleanInput);
  }

  // Security check: must start with baseDir
  const relativeFromBase = path.relative(baseDir, resolved);
  if (relativeFromBase.startsWith('..') || path.isAbsolute(relativeFromBase)) {
    logger.warn({ inputPath, baseDir }, '[SECURITY] Attempted path traversal outside music directory');
    throw new Error('Access denied: path is outside the music storage directory.');
  }

  // Relative path inside storage/music (e.g. "my-playlist/01.mp3")
  const relativePath = relativeFromBase.replace(/\\/g, '/');
  return { absolutePath: resolved, relativePath };
}

export interface ScannedAudioFile {
  name: string;
  relativePath: string;
  absolutePath: string;
  duration?: number;
}

/**
 * Check if an input string refers to an existing directory (absolute or within storage/music).
 */
export function isAudioFolder(input: string): boolean {
  try {
    const trimmed = input.trim();
    if (!trimmed) return false;
    if (path.isAbsolute(trimmed) && fs.existsSync(trimmed)) {
      return fs.statSync(trimmed).isDirectory();
    }
    const baseDir = path.resolve(resolveMusicStorageDir());
    const cleanInput = path.normalize(trimmed).replace(/^(\/|\\)+/, '');
    const inMusic = path.resolve(baseDir, cleanInput);
    if (fs.existsSync(inMusic) && fs.statSync(inMusic).isDirectory()) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Recursively collect audio files from a directory.
 */
async function collectAudioFiles(dir: string, baseDir: string): Promise<ScannedAudioFile[]> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const results: ScannedAudioFile[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await collectAudioFiles(fullPath, baseDir);
      results.push(...sub);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (SUPPORTED_AUDIO_EXTENSIONS.includes(ext)) {
        const displayName = path.basename(entry.name, path.extname(entry.name));
        const rel = path.relative(baseDir, fullPath).replace(/\\/g, '/');
        results.push({
          name: displayName,
          relativePath: rel,
          absolutePath: fullPath,
        });
      }
    }
  }

  return results;
}

/**
 * Scan a subfolder inside storage/music or an absolute local directory for supported audio files.
 * Preserves deterministic natural filename ordering.
 */
export async function scanFolderForAudio(folderInput: string): Promise<ScannedAudioFile[]> {
  const baseDir = path.resolve(resolveMusicStorageDir());
  let folderPath: string;

  if (path.isAbsolute(folderInput)) {
    folderPath = path.normalize(folderInput);
  } else {
    const cleanInput = path.normalize(folderInput).replace(/^(\/|\\)+/, '');
    if (cleanInput.startsWith('storage' + path.sep + 'music') || cleanInput.startsWith('storage/music')) {
      const rootDir = path.dirname(path.dirname(baseDir));
      folderPath = path.resolve(rootDir, cleanInput);
    } else {
      folderPath = path.resolve(baseDir, cleanInput);
    }
  }

  if (!fs.existsSync(folderPath)) {
    throw new Error(`Folder not found: ${folderInput}`);
  }

  const stat = await fs.promises.stat(folderPath);
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${folderInput}`);
  }

  const scanned = await collectAudioFiles(folderPath, folderPath);

  // Sort deterministically using natural alphanumeric comparison
  scanned.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
  );

  return scanned;
}

/**
 * Enqueue all audio files from a local folder into a guild's queue.
 */
export async function enqueueFolder(
  guildId: string,
  folderInput: string,
  queueManager: QueueManager,
  addedBy?: string,
): Promise<QueueTrack[]> {
  const scanned = await scanFolderForAudio(folderInput);
  if (scanned.length === 0) {
    throw new Error(`No supported audio files found in folder: ${folderInput}`);
  }

  const trackInputs = await Promise.all(
    scanned.map(async (file) => {
      let duration: number | undefined;
      let title = file.name;
      let artist: string | undefined;
      let album: string | undefined;

      try {
        const probed = await probeAudioMetadata(file.absolutePath);
        duration = probed.duration ?? undefined;
        if (probed.title) title = probed.title;
        if (probed.artist) artist = probed.artist;
        if (probed.album) album = probed.album;
      } catch {
        // Fallback without duration
      }

      return {
        name: title,
        path: file.absolutePath,
        duration,
        artist,
        album,
        sourceProvider: 'local',
        addedBy,
      };
    }),
  );

  return queueManager.addTracks(guildId, trackInputs);
}

/**
 * Enqueue a list of local audio files into a guild's queue in the same order.
 */
export async function enqueueMultipleFiles(
  guildId: string,
  fileInputs: string[],
  queueManager: QueueManager,
  addedBy?: string,
): Promise<QueueTrack[]> {
  if (fileInputs.length === 0) {
    return [];
  }

  const validatedInputs: Array<{
    name: string;
    path: string;
    duration?: number;
    addedBy?: string;
  }> = [];

  for (const input of fileInputs) {
    const trimmed = input.trim();
    if (!trimmed) continue;

    const { absolutePath, relativePath } = secureResolveMusicPath(trimmed);

    if (!fs.existsSync(absolutePath)) {
      throw new Error(`File not found: ${trimmed}`);
    }

    const stat = await fs.promises.stat(absolutePath);
    if (!stat.isFile()) {
      throw new Error(`Not a file: ${trimmed}`);
    }

    const ext = path.extname(absolutePath).toLowerCase();
    if (!SUPPORTED_AUDIO_EXTENSIONS.includes(ext)) {
      throw new Error(`Unsupported audio format "${ext}". Supported: ${SUPPORTED_AUDIO_EXTENSIONS.join(', ')}`);
    }

    let duration: number | undefined;
    try {
      const probed = await probeAudioMetadata(absolutePath);
      duration = probed.duration ?? undefined;
    } catch {
      // Fallback
    }

    const displayName = path.basename(absolutePath, path.extname(absolutePath));
    validatedInputs.push({
      name: displayName,
      path: relativePath,
      duration,
      addedBy,
    });
  }

  return queueManager.addTracks(guildId, validatedInputs);
}
