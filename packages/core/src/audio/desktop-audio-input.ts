import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { AudioInput } from './audio-input.interface';
import type { AudioDevice, AudioStream } from '../types/audio';

/**
 * Desktop Audio Input Implementation.
 * Prepares support for local microphone capture, future voice commands,
 * and virtual microphone inputs (Requirement 7).
 */
export class DesktopAudioInput extends EventEmitter implements AudioInput {
  readonly id = 'input-desktop';
  readonly name = 'Desktop Microphone / Audio Input';

  private isInitialized = false;
  private activeDeviceId: string | null = 'default-input';
  private isCapturing = false;
  private currentCaptureStream: PassThrough | null = null;

  private devices: Map<string, AudioDevice> = new Map();

  constructor(initialDevices?: AudioDevice[]) {
    super();
    if (initialDevices && initialDevices.length > 0) {
      for (const d of initialDevices) {
        this.devices.set(d.id, d);
      }
    } else {
      this.populateDefaultDevices();
    }
  }

  private populateDefaultDevices(): void {
    const defaultInput: AudioDevice = {
      id: 'default-input',
      name: 'Default Microphone (Realtek Audio)',
      type: 'input',
      sampleRate: 48000,
      channelCount: 1,
      isDefault: true,
      isVirtual: false,
    };
    const headsetMic: AudioDevice = {
      id: 'headset-mic-1',
      name: 'Headset Microphone',
      type: 'input',
      sampleRate: 48000,
      channelCount: 1,
      isDefault: false,
      isVirtual: false,
    };

    this.devices.set(defaultInput.id, defaultInput);
    this.devices.set(headsetMic.id, headsetMic);
  }

  async initialize(): Promise<void> {
    this.isInitialized = true;
  }

  async getDevices(): Promise<AudioDevice[]> {
    return Array.from(this.devices.values());
  }

  getActiveDeviceId(): string | null {
    return this.activeDeviceId;
  }

  async setDevice(deviceId: string): Promise<void> {
    const prev = this.activeDeviceId;
    if (this.devices.has(deviceId)) {
      this.activeDeviceId = deviceId;
    } else {
      // Fallback to default
      const defaultDev = Array.from(this.devices.values()).find((d) => d.isDefault);
      this.activeDeviceId = defaultDev ? defaultDev.id : 'default-input';
    }
    this.emit('deviceChanged', this.activeDeviceId, prev);
  }

  updateDevices(newDevices: AudioDevice[]): void {
    this.devices.clear();
    for (const d of newDevices) {
      this.devices.set(d.id, d);
    }
    if (this.activeDeviceId && !this.devices.has(this.activeDeviceId)) {
      const defaultDev = Array.from(this.devices.values()).find((d) => d.isDefault);
      this.activeDeviceId = defaultDev ? defaultDev.id : 'default-input';
    }
    this.emit('devicesUpdated', Array.from(this.devices.values()));
  }

  async startCapture(): Promise<AudioStream> {
    this.isCapturing = true;
    this.currentCaptureStream = new PassThrough();

    return {
      stream: this.currentCaptureStream,
      format: {
        sampleRate: 48000,
        channels: 1,
        bitDepth: 16,
        encoding: 'pcm_s16le',
      },
      metadata: {
        deviceId: this.activeDeviceId,
        capturedAt: new Date().toISOString(),
      },
    };
  }

  async stopCapture(): Promise<void> {
    this.isCapturing = false;
    if (this.currentCaptureStream) {
      this.currentCaptureStream.end();
      this.currentCaptureStream = null;
    }
  }

  isCurrentlyCapturing(): boolean {
    return this.isCapturing;
  }

  async dispose(): Promise<void> {
    await this.stopCapture();
    this.removeAllListeners();
    this.isInitialized = false;
  }
}
