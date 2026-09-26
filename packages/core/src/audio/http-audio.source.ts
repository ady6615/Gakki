import type { Readable } from 'node:stream';
import { AudioSource } from './audio-source';
import type { AudioMetadata } from '../types/audio';

/**
 * HTTP stream audio source.
 * Represents direct HTTP/HTTPS audio streams or remote audio files.
 */
export class HttpAudioSource extends AudioSource {
  readonly sourceType = 'http_stream' as const;
  readonly identifier: string;
  readonly url: string;

  private metadata: AudioMetadata | null = null;

  constructor(url: string, metadata?: Partial<AudioMetadata>) {
    super();
    this.identifier = url;
    this.url = url;

    if (metadata) {
      this.metadata = {
        title: metadata.title || url,
        artist: metadata.artist || null,
        album: metadata.album || null,
        duration: metadata.duration ?? null,
      };
    }
  }

  async validate(): Promise<void> {
    if (!this.url.startsWith('http://') && !this.url.startsWith('https://')) {
      throw new Error(`Invalid HTTP audio source URL: "${this.url}"`);
    }
  }

  async getMetadata(): Promise<AudioMetadata> {
    if (this.metadata) {
      return this.metadata;
    }

    this.metadata = {
      title: this.url,
      artist: null,
      album: null,
      duration: null,
    };

    return this.metadata;
  }

  async getStream(): Promise<Readable> {
    const res = await fetch(this.url);
    if (!res.ok || !res.body) {
      throw new Error(`HTTP stream request failed: ${res.status} ${res.statusText}`);
    }
    // @ts-expect-error Node fetch stream to Readable
    return Readable.fromWeb(res.body);
  }
}
