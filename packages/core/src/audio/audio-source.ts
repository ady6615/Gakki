import type { Readable } from 'node:stream';
import type { AudioMetadata } from '../types/audio';

/**
 * Abstract base class for all audio sources in Gakki.
 *
 * Designed to be platform-agnostic: whether audio comes from a local file,
 * YouTube stream, Spotify resolver, or custom audio generator, it conforms
 * to this interface.
 */
export abstract class AudioSource {
  /** Source type discriminator (e.g. 'local', 'youtube', 'url') */
  abstract readonly sourceType: string;

  /** Unique identifier or path for this source */
  abstract readonly identifier: string;

  /** Validate the source exists and is playable */
  abstract validate(): Promise<void>;

  /** Retrieve track metadata (title, artist, duration) */
  abstract getMetadata(): Promise<AudioMetadata>;

  /** Get a readable stream of audio data */
  abstract getStream(): Readable | Promise<Readable>;
}
