import { DesktopAudioOutput, VirtualAudioOutput, type AudioDevice } from '@gakki/core';
import { desktopLogger } from '../logger.js';

/**
 * Desktop audio output coordinator for the Electron main process.
 * Tracks OS audio device changes and fallback handling.
 */
export class ElectronAudioOutputCoordinator {
  public readonly desktopOutput: DesktopAudioOutput;
  public readonly virtualOutput: VirtualAudioOutput;

  constructor() {
    this.desktopOutput = new DesktopAudioOutput();
    this.virtualOutput = new VirtualAudioOutput();

    this.setupListeners();
  }

  private setupListeners(): void {
    this.desktopOutput.on('deviceChanged', (newDev, oldDev) => {
      desktopLogger.info('DESKTOP', `Output device changed: ${oldDev || 'none'} -> ${newDev}`);
    });

    this.desktopOutput.on('deviceFallback', (failed, fallback, reason) => {
      desktopLogger.warn('AUDIO', `Output failed on ${failed}; fallback to ${fallback}: ${reason}`);
    });

    this.desktopOutput.on('playbackRecovered', (dev) => {
      desktopLogger.info('AUDIO', `Playback recovered on device: ${dev}`);
    });
  }

  public async getDevices(): Promise<{
    outputs: AudioDevice[];
    virtualOutputs: AudioDevice[];
  }> {
    const outputs = await this.desktopOutput.getDevices();
    const virtualOutputs = await this.virtualOutput.getVirtualDevices();
    return { outputs, virtualOutputs };
  }

  public async setOutputDevice(deviceId: string): Promise<void> {
    await this.desktopOutput.setDevice(deviceId);
  }
}
