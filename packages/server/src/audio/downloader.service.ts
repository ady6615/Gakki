import * as fs from 'node:fs';
import * as path from 'node:path';
import youtubedl from 'youtube-dl-exec';
import {
  resolveMusicStorageDir,
  createLogger,
  type TrackManager,
} from '@gakki/core';
import { SpotifyParser, type SpotifyTrackMeta, type SpotifyCollectionMeta } from './spotify-parser';
import { YouTubeSourceProvider } from '../sources/youtube.provider';
import { probeAudioMetadata } from './ffmpeg';

const logger = createLogger('downloader-service');

export interface DownloadProgress {
  title: string;
  artist?: string;
  status: 'searching' | 'downloading' | 'tagging' | 'indexing' | 'completed' | 'failed';
  error?: string;
  outputPath?: string;
  current?: number;
  total?: number;
}

export interface DownloadResult {
  title: string;
  artist?: string;
  album?: string;
  filePath: string;
  relativePath: string;
  duration?: number;
  trackId?: string;
}

/**
 * spotDL-style Music Downloader Service.
 * Downloads audio from YouTube / YouTube Music with embedded ID3 metadata and album art,
 * storing tracks in storage/music and registering them in the PostgreSQL library.
 */
export class DownloaderService {
  private readonly musicDir: string;

  constructor(
    private readonly youtubeProvider: YouTubeSourceProvider,
    private readonly trackManager?: TrackManager,
  ) {
    this.musicDir = resolveMusicStorageDir();
    if (!fs.existsSync(this.musicDir)) {
      fs.mkdirSync(this.musicDir, { recursive: true });
    }
  }

  /**
   * Sanitize a filename to avoid illegal characters on Windows/Linux/macOS.
   */
  private sanitizeFilename(name: string): string {
    return name.replace(/[<>:"/\\|?*]/g, '_').trim();
  }

  /**
   * Download a single track from Spotify URL, YouTube URL, or search query.
   */
  async downloadTrack(
    input: string,
    onProgress?: (prog: DownloadProgress) => void,
  ): Promise<DownloadResult> {
    let title = 'Unknown Track';
    let artist = 'Unknown Artist';
    let album = 'Unknown Album';
    let targetYtUrl = input;

    onProgress?.({ title, status: 'searching' });

    // 1. Check if input is a Spotify track
    if (SpotifyParser.isSpotifyUrl(input)) {
      const parsed = SpotifyParser.parseIdentifier(input);
      if (parsed?.type === 'track') {
        const meta = await SpotifyParser.getTrackMetadata(input);
        title = meta.title;
        artist = meta.artist;
        album = meta.album || 'Single';

        onProgress?.({ title: `${artist} - ${title}`, artist, status: 'searching' });

        // Match against YouTube
        const searchResults = await this.youtubeProvider.search(`${artist} - ${title} audio`, { limit: 1 });
        if (searchResults.length === 0) {
          throw new Error(`Could not match Spotify track on YouTube: ${artist} - ${title}`);
        }
        targetYtUrl = searchResults[0].sourceUrl;
      } else {
        throw new Error('Please use downloadCollection for albums or playlists.');
      }
    } else if (input.startsWith('ytsearch:') || (!input.startsWith('http://') && !input.startsWith('https://'))) {
      // Keyword search
      const searchResults = await this.youtubeProvider.search(input, { limit: 1 });
      if (searchResults.length === 0) {
        throw new Error(`No YouTube results found for: ${input}`);
      }
      targetYtUrl = searchResults[0].sourceUrl;
      title = searchResults[0].title;
      artist = searchResults[0].artist || 'YouTube';
    }

    // 2. Prepare output folder & filename
    const safeArtist = this.sanitizeFilename(artist);
    const safeAlbum = this.sanitizeFilename(album);
    const safeTitle = this.sanitizeFilename(title);

    let targetDir = this.musicDir;
    if (safeArtist && safeArtist !== 'Unknown Artist' && safeArtist !== 'YouTube') {
      targetDir = path.join(this.musicDir, safeArtist, safeAlbum);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
    }

    const outputTemplate = path.join(targetDir, `${safeTitle}.%(ext)s`);
    const finalMp3Path = path.join(targetDir, `${safeTitle}.mp3`);

    // If file already exists, return existing
    if (fs.existsSync(finalMp3Path)) {
      logger.info({ finalMp3Path }, '[DOWNLOADER] Track already downloaded locally');
      const relativePath = path.relative(this.musicDir, finalMp3Path);
      const probed = await probeAudioMetadata(finalMp3Path).catch(() => ({ duration: undefined }));

      onProgress?.({
        title: `${artist} - ${title}`,
        artist,
        status: 'completed',
        outputPath: finalMp3Path,
      });

      return {
        title,
        artist,
        album,
        filePath: finalMp3Path,
        relativePath,
        duration: probed.duration ?? undefined,
      };
    }

    logger.info({ targetYtUrl, finalMp3Path }, '[DOWNLOADER] Starting audio extraction with yt-dlp');
    onProgress?.({ title: `${artist} - ${title}`, artist, status: 'downloading' });

    try {
      await youtubedl(targetYtUrl, {
        extractAudio: true,
        audioFormat: 'mp3',
        audioQuality: 0, // Best VBR quality
        embedThumbnail: true,
        addMetadata: true,
        output: outputTemplate,
        noCheckCertificates: true,
        noWarnings: true,
      });

      onProgress?.({ title: `${artist} - ${title}`, artist, status: 'indexing' });

      // Check if output file was created
      if (!fs.existsSync(finalMp3Path)) {
        // Find any file created in targetDir with safeTitle
        const files = fs.readdirSync(targetDir);
        const match = files.find((f) => f.startsWith(safeTitle));
        if (match) {
          const matchedPath = path.join(targetDir, match);
          fs.renameSync(matchedPath, finalMp3Path);
        } else {
          throw new Error('Downloaded audio file not found on disk after conversion.');
        }
      }

      // Probe duration and metadata
      const probed = await probeAudioMetadata(finalMp3Path).catch(() => ({
        duration: undefined,
        title: undefined,
        artist: undefined,
      }));

      const resolvedTitle = probed.title || title;
      const resolvedArtist = probed.artist || artist;
      const duration = probed.duration ?? undefined;
      const relativePath = path.relative(this.musicDir, finalMp3Path);

      // Register into PostgreSQL TrackManager if available
      let trackId: string | undefined;
      if (this.trackManager) {
        try {
          const saved = await this.trackManager.saveTrackWithSource(
            {
              title: resolvedTitle,
              artist: resolvedArtist,
              album: album !== 'Unknown Album' ? album : undefined,
              duration: duration ?? null,
            },
            {
              provider: 'local',
              sourceType: 'file',
              sourceUrl: relativePath,
            },
          );
          trackId = saved.track.id;
          logger.info({ trackId, title: resolvedTitle }, '[DOWNLOADER] Registered track in database');
        } catch (dbErr) {
          logger.warn({ dbErr }, '[DOWNLOADER] Could not register downloaded track in DB');
        }
      }

      onProgress?.({
        title: `${resolvedArtist} - ${resolvedTitle}`,
        artist: resolvedArtist,
        status: 'completed',
        outputPath: finalMp3Path,
      });

      return {
        title: resolvedTitle,
        artist: resolvedArtist,
        album,
        filePath: finalMp3Path,
        relativePath,
        duration,
        trackId,
      };
    } catch (err: any) {
      logger.error({ err, targetYtUrl }, '[DOWNLOADER] Download failed');
      onProgress?.({
        title: `${artist} - ${title}`,
        artist,
        status: 'failed',
        error: err.message,
      });
      throw err;
    }
  }

  /**
   * Download a full Spotify Playlist or Album in the background.
   */
  async downloadCollection(
    spotifyUrl: string,
    onProgress?: (prog: DownloadProgress) => void,
  ): Promise<DownloadResult[]> {
    const collection = await SpotifyParser.getCollection(spotifyUrl);
    logger.info(
      { type: collection.type, title: collection.title, count: collection.trackCount },
      '[DOWNLOADER] Downloading full collection',
    );

    const results: DownloadResult[] = [];
    const total = collection.tracks.length;

    for (let i = 0; i < total; i++) {
      const track = collection.tracks[i];
      const trackDisplay = `${track.artist} - ${track.title}`;

      onProgress?.({
        title: trackDisplay,
        artist: track.artist,
        status: 'searching',
        current: i + 1,
        total,
      });

      try {
        const res = await this.downloadTrack(track.spotifyUrl || `${track.artist} - ${track.title}`, (p) => {
          onProgress?.({ ...p, current: i + 1, total });
        });
        results.push(res);
      } catch (err: any) {
        logger.warn({ err, track: trackDisplay }, '[DOWNLOADER] Failed to download collection track, continuing next');
        onProgress?.({
          title: trackDisplay,
          artist: track.artist,
          status: 'failed',
          error: err.message,
          current: i + 1,
          total,
        });
      }
    }

    return results;
  }
}
