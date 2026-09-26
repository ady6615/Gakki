/**
 * Custom error hierarchy for Gakki audio system.
 */

export class AudioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AudioError';
  }
}

export class FileNotFoundError extends AudioError {
  constructor(public readonly filePath: string) {
    super(`File not found: ${filePath}`);
    this.name = 'FileNotFoundError';
  }
}

export class UnsupportedAudioFormatError extends AudioError {
  constructor(public readonly extension: string, public readonly supported: string[]) {
    super(`Unsupported audio format "${extension}". Supported formats: ${supported.join(', ')}`);
    this.name = 'UnsupportedAudioFormatError';
  }
}

export class AudioFileEmptyError extends AudioError {
  constructor(public readonly filePath: string) {
    super(`Audio file is empty: ${filePath}`);
    this.name = 'AudioFileEmptyError';
  }
}

export class VoiceChannelRequiredError extends AudioError {
  constructor() {
    super('You must be in a voice channel to use this command.');
    this.name = 'VoiceChannelRequiredError';
  }
}

export class VoicePermissionError extends AudioError {
  constructor(public readonly missingPermissions: string[]) {
    super(`Bot is missing required voice permissions: ${missingPermissions.join(', ')}`);
    this.name = 'VoicePermissionError';
  }
}

export class PlaybackError extends AudioError {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'PlaybackError';
  }
}
