import type { Readable } from 'node:stream';
import type { AudioMetadata } from '../types/audio';
import { AudioSource } from './audio-source';

export interface TransitionStreamProvider {
  getStream(): Promise<Readable>;
}

export class TransitionAudioSource extends AudioSource {
  readonly sourceType = 'transition';
  readonly identifier: string;
  readonly isRawPcmStream = true;

  constructor(
    identifier: string,
    private readonly metadata: AudioMetadata,
    private readonly streamProvider: TransitionStreamProvider | (() => Promise<Readable>),
  ) {
    super();
    this.identifier = identifier;
  }

  async validate(): Promise<void> {
    // Valid by construction
  }

  async getMetadata(): Promise<AudioMetadata> {
    return this.metadata;
  }

  async getStream(): Promise<Readable> {
    if (typeof this.streamProvider === 'function') {
      return this.streamProvider();
    }
    return this.streamProvider.getStream();
  }
}
