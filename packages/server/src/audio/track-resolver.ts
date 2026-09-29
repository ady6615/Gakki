import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  SUPPORTED_AUDIO_EXTENSIONS,
  resolveMusicStorageDir,
  createLogger,
  type AudioSourceManager,
  type TrackManager,
  type QueueTrack,
} from '@gakki/core';
import { probeAudioMetadata } from './ffmpeg';

const logger = createLogger('track-resolver');

export interface ResolvedAudioInput {
  name: string;
  path: string;
  duration?: number;
  artist?: string;
  album?: string;
  thumbnailUrl?: string;
  sourceProvider?: string;
  sourceUrl?: string;
}

/**
 * Universal Audio Input Resolver.
 *
 * Resolves any user-provided music input:
 * 1. Direct audio links (HTTP/HTTPS streams)
 * 2. SoundCloud links
 * 3. Spotify track IDs or URLs (via public oEmbed, auto-matching local tracks if available)
 * 4. Local files anywhere on the host filesystem (absolute paths)
 * 5. Relative files in storage/music
 * 6. Database track IDs in PostgreSQL
 * 7. Keyword search matches in local music storage
 */
export async function resolveAnyAudioInput(
  rawInput: string,
  audioSourceManager?: AudioSourceManager,
  trackManager?: TrackManager,
): Promise<ResolvedAudioInput> {
  const input = rawInput.trim();
  if (!input) {
    throw new Error('Music input cannot be empty.');
  }

  const musicDir = resolveMusicStorageDir();

  // ── 1. Check for Spotify Links, URIs, or Track IDs ──────────────
  const spotifyTrackMatch =
    input.match(/open\.spotify\.com\/track\/([0-9a-zA-Z]{22})/i) ||
    input.match(/^spotify:track:([0-9a-zA-Z]{22})$/i) ||
    (input.length === 22 && /^[0-9a-zA-Z]{22}$/.test(input) ? [null, input] : null);

  if (spotifyTrackMatch) {
    const trackId = spotifyTrackMatch[1];
    logger.info({ trackId }, '[RESOLVER] Detected Spotify track identifier, querying metadata');

    try {
      const oembedUrl = `https://open.spotify.com/oembed?url=https://open.spotify.com/track/${trackId}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);

      const res = await fetch(oembedUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'GakkiMusicPlatform/1.0' },
      });
      clearTimeout(timeout);

      if (res.ok) {
        const data = (await res.json()) as { title?: string; thumbnail_url?: string };
        const spotifyTitle = data.title || 'Spotify Track';
        const spotifyThumb = data.thumbnail_url;

        // Check if a local audio file matches this title
        const localMatch = findMatchingLocalFile(spotifyTitle, musicDir);
        if (localMatch) {
          logger.info({ spotifyTitle, localFile: localMatch.path }, '[RESOLVER] Matched Spotify track to local file');
          return {
            name: spotifyTitle,
            path: localMatch.path,
            duration: localMatch.duration,
            thumbnailUrl: spotifyThumb,
            sourceProvider: 'spotify',
            sourceUrl: `https://open.spotify.com/track/${trackId}`,
          };
        }

        // If not found in storage, check PostgreSQL trackManager
        if (trackManager) {
          const allTracks = await trackManager.getAllTracks(100);
          const dbMatch = allTracks.find(
            (t) => t.title.toLowerCase().includes(spotifyTitle.toLowerCase()) ||
                   spotifyTitle.toLowerCase().includes(t.title.toLowerCase())
          );
          if (dbMatch) {
            const primarySource = await trackManager.getPrimarySourceByTrackId(dbMatch.id);
            return {
              name: dbMatch.title,
              path: primarySource?.sourceUrl || dbMatch.title,
              duration: dbMatch.duration ?? undefined,
              artist: dbMatch.artist ?? undefined,
              album: dbMatch.album ?? undefined,
              thumbnailUrl: spotifyThumb,
              sourceProvider: 'spotify',
              sourceUrl: `https://open.spotify.com/track/${trackId}`,
            };
          }
        }

        throw new Error(
          `Spotify track "${spotifyTitle}" identified, but no local audio file was found in your library. Please upload or add "${spotifyTitle}.mp3" to your storage/music folder to play it.`
        );
      }
    } catch (err: any) {
      if (err.message && err.message.includes('identified, but no local audio file')) {
        throw err;
      }
      logger.warn({ err, trackId }, '[RESOLVER] Spotify oEmbed query failed');
    }
  }

  // ── 2. External URLs (HTTP / HTTPS / SoundCloud) ────────────────
  if (input.startsWith('http://') || input.startsWith('https://')) {
    // Check if registered AudioSourceManager can handle it
    if (audioSourceManager && audioSourceManager.canHandle(input)) {
      try {
        const resolved = await audioSourceManager.resolve(input);
        return {
          name: resolved.title,
          path: resolved.streamUrlOrPath,
          duration: resolved.metadata.duration ?? undefined,
          artist: resolved.metadata.artist ?? undefined,
          album: resolved.metadata.album ?? undefined,
          thumbnailUrl: resolved.metadata.thumbnailUrl ?? resolved.metadata.coverArtPath ?? undefined,
          sourceProvider: resolved.source.provider,
          sourceUrl: input,
        };
      } catch (err: any) {
        throw new Error(err.message || `Failed to resolve stream URL: ${input}`);
      }
    }

    // Direct HTTP stream fallback
    try {
      const parsedUrl = new URL(input);
      const baseName = path.basename(parsedUrl.pathname);
      const displayName = baseName && baseName !== '/' ? decodeURIComponent(baseName) : parsedUrl.hostname;

      return {
        name: displayName,
        path: input,
        sourceProvider: 'http_stream',
        sourceUrl: input,
      };
    } catch {
      throw new Error(`Invalid URL format: ${input}`);
    }
  }

  // ── 3. Absolute Filesystem Path ─────────────────────────────────
  if (path.isAbsolute(input) && fs.existsSync(input)) {
    const stat = await fs.promises.stat(input);
    if (stat.isFile()) {
      const ext = path.extname(input).toLowerCase();
      if (!SUPPORTED_AUDIO_EXTENSIONS.includes(ext)) {
        throw new Error(`Unsupported audio format "${ext}". Supported: ${SUPPORTED_AUDIO_EXTENSIONS.join(', ')}`);
      }

      let duration: number | undefined;
      let title: string | undefined;
      let artist: string | undefined;
      let album: string | undefined;

      try {
        const probed = await probeAudioMetadata(input);
        duration = probed.duration ?? undefined;
        title = probed.title ?? undefined;
        artist = probed.artist ?? undefined;
        album = probed.album ?? undefined;
      } catch {
        // Probe failed, fallback to filename
      }

      return {
        name: title || path.basename(input, path.extname(input)),
        path: input,
        duration,
        artist,
        album,
        sourceProvider: 'local',
      };
    }
  }

  // ── 4. File in storage/music directory ──────────────────────────
  const candidateDirect = path.resolve(musicDir, input);
  if (fs.existsSync(candidateDirect)) {
    const stat = await fs.promises.stat(candidateDirect);
    if (stat.isFile()) {
      let duration: number | undefined;
      let title: string | undefined;
      let artist: string | undefined;
      let album: string | undefined;

      try {
        const probed = await probeAudioMetadata(candidateDirect);
        duration = probed.duration ?? undefined;
        title = probed.title ?? undefined;
        artist = probed.artist ?? undefined;
        album = probed.album ?? undefined;
      } catch {
        // Fallback
      }

      return {
        name: title || path.basename(candidateDirect, path.extname(candidateDirect)),
        path: input,
        duration,
        artist,
        album,
        sourceProvider: 'local',
      };
    }
  }

  // Try appending supported extensions to the candidate in storage/music
  for (const ext of SUPPORTED_AUDIO_EXTENSIONS) {
    const withExt = path.resolve(musicDir, `${input}${ext}`);
    if (fs.existsSync(withExt)) {
      let duration: number | undefined;
      try {
        const probed = await probeAudioMetadata(withExt);
        duration = probed.duration ?? undefined;
      } catch {
        // ignore
      }

      return {
        name: path.basename(withExt, ext),
        path: `${input}${ext}`,
        duration,
        sourceProvider: 'local',
      };
    }
  }

  // ── 5. Database Track ID ─────────────────────────────────────────
  if (trackManager) {
    const trackRow = await trackManager.getTrackById(input);
    if (trackRow) {
      const primarySource = await trackManager.getPrimarySourceByTrackId(trackRow.id);
      return {
        name: trackRow.title,
        path: primarySource?.sourceUrl || trackRow.title,
        duration: trackRow.duration ?? undefined,
        artist: trackRow.artist ?? undefined,
        album: trackRow.album ?? undefined,
        sourceProvider: 'database',
      };
    }
  }

  // ── 6. Local Library Fuzzy Search ───────────────────────────────
  const fuzzyMatch = findMatchingLocalFile(input, musicDir);
  if (fuzzyMatch) {
    return {
      name: fuzzyMatch.name,
      path: fuzzyMatch.path,
      duration: fuzzyMatch.duration,
      sourceProvider: 'local',
    };
  }

  // ── 7. Not Found ────────────────────────────────────────────────
  throw new Error(
    `File not found: "${input}". Please provide a valid local audio file path, direct audio link (e.g. SoundCloud, HTTP stream), or upload an audio file.`
  );
}

/**
 * Search storage/music for a local audio file matching a search query.
 */
function findMatchingLocalFile(
  query: string,
  musicDir: string,
): { name: string; path: string; duration?: number } | null {
  if (!fs.existsSync(musicDir)) return null;

  try {
    const cleanQuery = query.toLowerCase().replace(/[^a-z0-9]/g, '');
    const files = fs.readdirSync(musicDir, { withFileTypes: true });

    for (const f of files) {
      if (!f.isFile()) continue;
      const ext = path.extname(f.name).toLowerCase();
      if (!SUPPORTED_AUDIO_EXTENSIONS.includes(ext)) continue;

      const baseName = path.basename(f.name, ext);
      const cleanBase = baseName.toLowerCase().replace(/[^a-z0-9]/g, '');

      if (cleanBase.includes(cleanQuery) || cleanQuery.includes(cleanBase)) {
        return {
          name: baseName,
          path: f.name,
        };
      }
    }
  } catch {
    // ignore
  }

  return null;
}
