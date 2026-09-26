import * as path from 'node:path';
import * as fs from 'node:fs';
import type {
  MusicSourceProvider,
  MusicSearchProvider,
  ResolvedTrack,
  TrackMetadata,
  SearchResult,
  SearchOptions,
} from '@gakki/core';
import {
  LocalAudioSource,
  SUPPORTED_AUDIO_EXTENSIONS,
  resolveMusicStorageDir,
  createLogger,
} from '@gakki/core';
import { probeAudioMetadata } from '../audio/ffmpeg';
import { ArtworkService } from '../services/artwork.service';

const logger = createLogger('local-source-provider');

export class LocalSourceProvider implements MusicSourceProvider, MusicSearchProvider {
  readonly name = 'local';
  private readonly musicDir: string;

  constructor(
    private readonly artworkService?: ArtworkService,
    musicDir?: string,
  ) {
    this.musicDir = musicDir ?? resolveMusicStorageDir();
  }

  /**
   * Can handle any string ending with a supported extension or matching a local audio file.
   */
  canHandle(input: string): boolean {
    if (input.startsWith('http://') || input.startsWith('https://')) {
      return false;
    }

    const ext = path.extname(input).toLowerCase();
    if (SUPPORTED_AUDIO_EXTENSIONS.includes(ext)) {
      return true;
    }

    // Check if filename with extension exists in storage/music
    for (const testExt of SUPPORTED_AUDIO_EXTENSIONS) {
      if (fs.existsSync(path.join(this.musicDir, `${input}${testExt}`))) {
        return true;
      }
    }

    return false;
  }

  /**
   * Extract rich metadata for a local file.
   */
  async getMetadata(input: string): Promise<TrackMetadata> {
    const source = new LocalAudioSource(input, this.musicDir, probeAudioMetadata);
    await source.validate();

    const basic = await source.getMetadata();
    const resolvedPath = source.resolvedPath;

    // Extract embedded artwork if available
    let coverArtPath: string | null = null;
    if (this.artworkService) {
      coverArtPath = await this.artworkService.extractEmbeddedArtwork(resolvedPath);
    }

    const metadata: TrackMetadata = {
      title: basic.title || path.basename(resolvedPath, path.extname(resolvedPath)),
      artist: basic.artist || null,
      album: basic.album || null,
      albumArtist: null,
      duration: basic.duration || null,
      genre: null,
      year: null,
      trackNumber: null,
      thumbnailUrl: coverArtPath,
      coverArtPath,
    };

    logger.info(
      { file: path.basename(resolvedPath), title: metadata.title, artist: metadata.artist },
      '[METADATA] Extracted: %s',
      metadata.title,
    );

    return metadata;
  }

  /**
   * Resolve local audio input into a playable ResolvedTrack.
   */
  async resolve(input: string): Promise<ResolvedTrack> {
    const metadata = await this.getMetadata(input);
    const source = new LocalAudioSource(input, this.musicDir);
    await source.validate();

    const relativePath = path.relative(this.musicDir, source.resolvedPath);
    const safePath = relativePath.startsWith('..') ? path.basename(source.resolvedPath) : relativePath;

    return {
      title: metadata.title,
      metadata,
      source: {
        provider: 'local',
        sourceType: 'file',
        sourceUrl: safePath.replace(/\\/g, '/'),
        isEphemeral: false,
      },
      streamUrlOrPath: source.resolvedPath,
      isStream: false,
    };
  }

  /**
   * Search local files in storage/music directory.
   */
  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const limit = options.limit ?? 5;
    const results: SearchResult[] = [];
    const q = query.toLowerCase().trim();

    if (!fs.existsSync(this.musicDir)) {
      return results;
    }

    const entries = fs.readdirSync(this.musicDir);
    for (const file of entries) {
      const ext = path.extname(file).toLowerCase();
      if (!SUPPORTED_AUDIO_EXTENSIONS.includes(ext)) continue;

      const nameWithoutExt = path.basename(file, ext);
      if (nameWithoutExt.toLowerCase().includes(q) || file.toLowerCase().includes(q)) {
        try {
          const fullPath = path.join(this.musicDir, file);
          const probed = await probeAudioMetadata(fullPath);
          results.push({
            title: probed.title || nameWithoutExt,
            artist: probed.artist || 'Local Library',
            album: probed.album || null,
            duration: probed.duration || null,
            provider: 'local',
            sourceUrl: file,
          });
        } catch {
          results.push({
            title: nameWithoutExt,
            artist: 'Local Library',
            provider: 'local',
            sourceUrl: file,
          });
        }

        if (results.length >= limit) break;
      }
    }

    return results;
  }
}
