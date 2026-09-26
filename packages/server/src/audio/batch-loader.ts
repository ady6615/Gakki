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
 * Scan a subfolder inside storage/music for supported audio files.
 * Ignores unsupported files and subdirectories.
 * Preserves deterministic natural filename ordering.
 */
export async function scanFolderForAudio(folderInput: string): Promise<ScannedAudioFile[]> {
  const { absolutePath: folderPath, relativePath: folderRelative } =
    secureResolveMusicPath(folderInput);

  if (!fs.existsSync(folderPath)) {
    throw new Error(`Folder not found: ${folderInput}`);
  }

  const stat = await fs.promises.stat(folderPath);
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${folderInput}`);
  }

  const dirEntries = await fs.promises.readdir(folderPath, { withFileTypes: true });

  // Filter for regular files with supported extensions
  const audioEntries = dirEntries.filter((entry) => {
    if (!entry.isFile()) return false;
    const ext = path.extname(entry.name).toLowerCase();
    return SUPPORTED_AUDIO_EXTENSIONS.includes(ext);
  });

  // Sort deterministically using natural alphanumeric comparison
  audioEntries.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
  );

  const scanned: ScannedAudioFile[] = [];
  for (const entry of audioEntries) {
    const entryAbsPath = path.join(folderPath, entry.name);
    const entryRelPath = folderRelative
      ? `${folderRelative}/${entry.name}`.replace(/\\/g, '/')
      : entry.name;
    const displayName = path.basename(entry.name, path.extname(entry.name));

    scanned.push({
      name: displayName,
      relativePath: entryRelPath,
      absolutePath: entryAbsPath,
    });
  }

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
      try {
        const probed = await probeAudioMetadata(file.absolutePath);
        duration = probed.duration ?? undefined;
      } catch {
        // Fallback without duration
      }

      return {
        name: file.name,
        path: file.relativePath,
        duration,
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
