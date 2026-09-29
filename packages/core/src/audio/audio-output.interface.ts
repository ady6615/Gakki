import type { AudioDevice, AudioStream, PlaybackTarget } from '../types/audio';

/**
 * Platform-independent Audio Output Interface
 *
 * Implemented by DiscordAudioOutput, DesktopAudioOutput, and future adapters.
 */
export interface AudioOutput {
  readonly id: string;
  readonly name: string;
  readonly targetType: PlaybackTarget;

  initialize(): Promise<void>;

  start(stream: AudioStream): Promise<void>;

  stop(): Promise<void>;

  setVolume(volume: number): Promise<void>;

  getDevices(): Promise<AudioDevice[]>;

  setDevice(deviceId: string): Promise<void>;

  getActiveDeviceId(): string | null;

  dispose(): Promise<void>;
}
