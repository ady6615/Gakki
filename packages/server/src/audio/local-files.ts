import * as fs from 'node:fs';
import * as path from 'node:path';
import { SUPPORTED_AUDIO_EXTENSIONS, resolveMusicStorageDir } from '@gakki/core';

export function getMusicStorageDir(): string {
  return resolveMusicStorageDir();
}

/**
 * List all local audio files in storage/music directory.
 */
export async function listLocalAudioFiles(): Promise<string[]> {
  const dir = getMusicStorageDir();
  if (!fs.existsSync(dir)) {
    return [];
  }

  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => {
      const ext = path.extname(name).toLowerCase();
      return SUPPORTED_AUDIO_EXTENSIONS.includes(ext);
    });
}
