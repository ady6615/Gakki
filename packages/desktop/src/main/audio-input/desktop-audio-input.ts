import { DesktopAudioInput, type AudioDevice } from '@gakki/core';
import { desktopLogger } from '../logger.js';

/**
 * Desktop audio input coordinator for the Electron main process.
 */
export class ElectronAudioInputCoordinator {
  public readonly desktopInput: DesktopAudioInput;

  constructor() {
    this.desktopInput = new DesktopAudioInput();

    this.desktopInput.on('deviceChanged', (newDev, oldDev) => {
      desktopLogger.info('AUDIO', `Input device changed: ${oldDev || 'none'} -> ${newDev}`);
    });
  }

  public async getDevices(): Promise<AudioDevice[]> {
    return this.desktopInput.getDevices();
  }

  public async setInputDevice(deviceId: string): Promise<void> {
    await this.desktopInput.setDevice(deviceId);
  }
}
