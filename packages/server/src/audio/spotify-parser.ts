import { createLogger } from '@gakki/core';

const logger = createLogger('spotify-parser');

export interface SpotifyTrackMeta {
  title: string;
  artist: string;
  album?: string;
  durationMs?: number;
  durationSec?: number;
  thumbnailUrl?: string;
  spotifyUrl: string;
  spotifyId: string;
}

export interface SpotifyCollectionMeta {
  type: 'playlist' | 'album';
  title: string;
  description?: string;
  author?: string;
  thumbnailUrl?: string;
  trackCount: number;
  tracks: SpotifyTrackMeta[];
}

/**
 * Parses Spotify Track, Album, and Playlist URLs without requiring developer API credentials.
 * Utilizes public oEmbed and embed hydration data.
 */
export class SpotifyParser {
  private static readonly USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

  /**
   * Determine whether an input string is a Spotify URL or URI.
   */
  public static isSpotifyUrl(input: string): boolean {
    const trimmed = input.trim().toLowerCase();
    return (
      trimmed.includes('open.spotify.com/track/') ||
      trimmed.includes('open.spotify.com/album/') ||
      trimmed.includes('open.spotify.com/playlist/') ||
      trimmed.startsWith('spotify:track:') ||
      trimmed.startsWith('spotify:album:') ||
      trimmed.startsWith('spotify:playlist:')
    );
  }

  /**
   * Parse type and identifier from a Spotify URL.
   */
  public static parseIdentifier(input: string): { type: 'track' | 'album' | 'playlist'; id: string } | null {
    const trimmed = input.trim();

    // Track
    let match =
      trimmed.match(/open\.spotify\.com\/track\/([a-zA-Z0-9]{22})/i) ||
      trimmed.match(/^spotify:track:([a-zA-Z0-9]{22})$/i);
    if (match) return { type: 'track', id: match[1] };

    // Playlist
    match =
      trimmed.match(/open\.spotify\.com\/playlist\/([a-zA-Z0-9]{22})/i) ||
      trimmed.match(/^spotify:playlist:([a-zA-Z0-9]{22})$/i);
    if (match) return { type: 'playlist', id: match[1] };

    // Album
    match =
      trimmed.match(/open\.spotify\.com\/album\/([a-zA-Z0-9]{22})/i) ||
      trimmed.match(/^spotify:album:([a-zA-Z0-9]{22})$/i);
    if (match) return { type: 'album', id: match[1] };

    return null;
  }

  /**
   * Fetch single track metadata.
   */
  public static async getTrackMetadata(spotifyUrlOrId: string): Promise<SpotifyTrackMeta> {
    const parsed = this.parseIdentifier(spotifyUrlOrId);
    const trackId = parsed?.type === 'track' ? parsed.id : spotifyUrlOrId.replace(/^spotify:track:/, '');

    const embedUrl = `https://open.spotify.com/embed/track/${trackId}`;
    try {
      const res = await fetch(embedUrl, {
        headers: { 'User-Agent': this.USER_AGENT },
      });

      if (res.ok) {
        const html = await res.text();
        const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);

        if (nextDataMatch) {
          const data = JSON.parse(nextDataMatch[1]);
          const entity = data.props?.pageProps?.state?.data?.entity;

          if (entity) {
            const artists = entity.artists?.map((a: any) => a.name).join(', ') || 'Unknown Artist';
            const durationMs = entity.duration || 0;
            const coverUrl = entity.visualIdentity?.image?.[0]?.url;

            return {
              title: entity.name || 'Unknown Track',
              artist: artists,
              album: entity.album?.name,
              durationMs,
              durationSec: Math.round(durationMs / 1000),
              thumbnailUrl: coverUrl,
              spotifyUrl: `https://open.spotify.com/track/${trackId}`,
              spotifyId: trackId,
            };
          }
        }
      }
    } catch (err) {
      logger.warn({ err, trackId }, '[SPOTIFY-PARSER] Embed hydration extraction failed, trying oEmbed fallback');
    }

    // Fallback to oEmbed
    const oembedUrl = `https://open.spotify.com/oembed?url=https://open.spotify.com/track/${trackId}`;
    const oembedRes = await fetch(oembedUrl, {
      headers: { 'User-Agent': this.USER_AGENT },
    });

    if (!oembedRes.ok) {
      throw new Error(`Failed to fetch Spotify track metadata for ID: ${trackId}`);
    }

    const oembedData = (await oembedRes.json()) as { title?: string; thumbnail_url?: string };
    const rawTitle = oembedData.title || 'Spotify Track';

    // Often formatted as "Track Title - song and lyrics by Artist | Spotify"
    let title = rawTitle;
    let artist = 'Spotify';
    if (rawTitle.includes(' - song and lyrics by ')) {
      const parts = rawTitle.split(' - song and lyrics by ');
      title = parts[0].trim();
      artist = parts[1].replace(/ \| Spotify$/i, '').trim();
    } else if (rawTitle.includes(' by ')) {
      const parts = rawTitle.split(' by ');
      title = parts[0].trim();
      artist = parts[1].replace(/ \| Spotify$/i, '').trim();
    }

    return {
      title,
      artist,
      thumbnailUrl: oembedData.thumbnail_url,
      spotifyUrl: `https://open.spotify.com/track/${trackId}`,
      spotifyId: trackId,
    };
  }

  /**
   * Fetch album or playlist metadata along with track list.
   */
  public static async getCollection(spotifyUrlOrId: string): Promise<SpotifyCollectionMeta> {
    const parsed = this.parseIdentifier(spotifyUrlOrId);
    if (!parsed || (parsed.type !== 'playlist' && parsed.type !== 'album')) {
      throw new Error('Provided URL is not a valid Spotify album or playlist');
    }

    const embedUrl = `https://open.spotify.com/embed/${parsed.type}/${parsed.id}`;
    const res = await fetch(embedUrl, {
      headers: { 'User-Agent': this.USER_AGENT },
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch Spotify ${parsed.type} (HTTP ${res.status})`);
    }

    const html = await res.text();
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);

    if (!nextDataMatch) {
      throw new Error(`Could not parse Spotify ${parsed.type} hydration payload`);
    }

    const data = JSON.parse(nextDataMatch[1]);
    const entity = data.props?.pageProps?.state?.data?.entity;

    if (!entity) {
      throw new Error(`Spotify ${parsed.type} entity data missing from response`);
    }

    const collectionTitle = entity.name || `Spotify ${parsed.type}`;
    const collectionCover = entity.visualIdentity?.image?.[0]?.url;
    const author =
      parsed.type === 'album'
        ? entity.artists?.map((a: any) => a.name).join(', ')
        : entity.owner?.name;

    const rawTracks: any[] = entity.trackList || [];
    const tracks: SpotifyTrackMeta[] = rawTracks.map((t) => {
      const trackId = t.uri ? t.uri.replace('spotify:track:', '') : '';
      return {
        title: t.title || 'Unknown Track',
        artist: t.subtitle || author || 'Unknown Artist',
        album: parsed.type === 'album' ? collectionTitle : undefined,
        durationMs: t.duration,
        durationSec: t.duration ? Math.round(t.duration / 1000) : undefined,
        thumbnailUrl: collectionCover,
        spotifyUrl: trackId ? `https://open.spotify.com/track/${trackId}` : '',
        spotifyId: trackId,
      };
    });

    return {
      type: parsed.type,
      title: collectionTitle,
      description: entity.description,
      author,
      thumbnailUrl: collectionCover,
      trackCount: tracks.length,
      tracks,
    };
  }
}
