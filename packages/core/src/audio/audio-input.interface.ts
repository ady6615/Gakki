import type { AudioDevice, AudioStream } from '../types/audio';

/**
 * Platform-independent Audio Input Interface
 *
 * Prepares support for microphone recording, voice commands,
 * virtual microphone input, and future platform adapters.
 */
export interface AudioInput {
  readonly id: string;
  readonly name: string;

  initialize(): Promise<void>;

  getDevices(): Promise<AudioDevice[]>;

  setDevice(deviceId: string): Promise<void>;

  getActiveDeviceId(): string | null;

  startCapture(): Promise<AudioStream>;

  stopCapture(): Promise<void>;

  dispose(): Promise<void>;
}
