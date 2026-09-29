import type { AudioOutput } from './audio-output.interface';
import type { AudioDevice, AudioStream, PlaybackTarget } from '../types/audio';

/**
 * Discord Voice Audio Output Implementation.
 * Bridges Gakki Audio Engine output streams to Discord voice channels.
 */
export class DiscordAudioOutput implements AudioOutput {
  readonly id = 'output-discord';
  readonly name = 'Discord Voice Channel';
  readonly targetType: PlaybackTarget = 'discord';

  private isInitialized = false;
  private currentVolume = 100;
  private activeDeviceId: string | null = 'discord-default';
  private currentStream: AudioStream | null = null;

  constructor(private readonly voicePlayer?: any) {}

  async initialize(): Promise<void> {
    this.isInitialized = true;
  }

  async start(stream: AudioStream): Promise<void> {
    this.currentStream = stream;
    if (this.voicePlayer && typeof this.voicePlayer.playStream === 'function') {
      await this.voicePlayer.playStream(stream.stream);
    }
  }

  async stop(): Promise<void> {
    this.currentStream = null;
    if (this.voicePlayer && typeof this.voicePlayer.stop === 'function') {
      this.voicePlayer.stop();
    }
  }

  async setVolume(volume: number): Promise<void> {
    this.currentVolume = Math.max(0, Math.min(200, volume));
    if (this.voicePlayer && typeof this.voicePlayer.setVolume === 'function') {
      this.voicePlayer.setVolume(this.currentVolume);
    }
  }

  async getDevices(): Promise<AudioDevice[]> {
    return [
      {
        id: 'discord-default',
        name: 'Discord Audio Pipeline (Opus 48kHz Stereo)',
        type: 'output',
        sampleRate: 48000,
        channelCount: 2,
        isDefault: true,
        isVirtual: false,
      },
    ];
  }

  async setDevice(deviceId: string): Promise<void> {
    this.activeDeviceId = deviceId;
  }

  getActiveDeviceId(): string | null {
    return this.activeDeviceId;
  }

  async dispose(): Promise<void> {
    await this.stop();
    this.isInitialized = false;
  }
}
