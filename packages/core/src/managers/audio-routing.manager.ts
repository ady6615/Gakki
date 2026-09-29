import { EventEmitter } from 'node:events';
import type { AudioOutput } from '../audio/audio-output.interface';
import type { AudioInput } from '../audio/audio-input.interface';
import { DiscordAudioOutput } from '../audio/discord-audio-output';
import { DesktopAudioOutput } from '../audio/desktop-audio-output';
import { VirtualAudioOutput } from '../audio/virtual-audio-output';
import { DesktopAudioInput } from '../audio/desktop-audio-input';
import type { AudioDevice, AudioRoutingState, PlaybackTarget } from '../types/audio';

export interface AudioRoutingEvents {
  targetChanged: (newTarget: PlaybackTarget, previousTarget: PlaybackTarget) => void;
  outputDeviceChanged: (deviceId: string, target: PlaybackTarget) => void;
  inputDeviceChanged: (deviceId: string) => void;
  deviceFallback: (failedDeviceId: string, fallbackDeviceId: string, reason: string) => void;
  monitoringChanged: (enabled: boolean, monitorDeviceId: string | null) => void;
}

/**
 * Audio Routing Manager.
 * Orchestrates multi-target audio outputs (Discord, Desktop, Virtual Output)
 * and audio input capture, ensuring that switching outputs retains the queue,
 * track position, volume, and DJ state seamlessly.
 */
export class AudioRoutingManager extends EventEmitter {
  private activeTarget: PlaybackTarget = 'desktop';
  private readonly outputs: Map<PlaybackTarget, AudioOutput> = new Map();
  private input: AudioInput;

  constructor(options?: {
    discordOutput?: AudioOutput;
    desktopOutput?: DesktopAudioOutput;
    virtualOutput?: VirtualAudioOutput;
    input?: AudioInput;
    initialTarget?: PlaybackTarget;
  }) {
    super();
    const discord = options?.discordOutput || new DiscordAudioOutput();
    const desktop = options?.desktopOutput || new DesktopAudioOutput();
    const virtual = options?.virtualOutput || new VirtualAudioOutput();
    this.input = options?.input || new DesktopAudioInput();

    this.outputs.set('discord', discord);
    this.outputs.set('desktop', desktop);
    this.outputs.set('virtual', virtual);

    if (options?.initialTarget) {
      this.activeTarget = options.initialTarget;
    }

    // Forward fallback and device change events from outputs
    if (desktop instanceof DesktopAudioOutput) {
      desktop.on('deviceFallback', (failed, fallback, reason) => {
        this.emit('deviceFallback', failed, fallback, reason);
      });
      desktop.on('deviceChanged', (newDev) => {
        this.emit('outputDeviceChanged', newDev, 'desktop');
      });
    }

    if (virtual instanceof VirtualAudioOutput) {
      virtual.on('deviceFallback', (failed, fallback, reason) => {
        this.emit('deviceFallback', failed, fallback, reason);
      });
      virtual.on('deviceChanged', (newDev) => {
        this.emit('outputDeviceChanged', newDev, 'virtual');
      });
    }
  }

  async initialize(): Promise<void> {
    for (const output of this.outputs.values()) {
      await output.initialize();
    }
    await this.input.initialize();
  }

  getActiveTarget(): PlaybackTarget {
    return this.activeTarget;
  }

  getActiveOutput(): AudioOutput {
    const out = this.outputs.get(this.activeTarget);
    if (!out) {
      return this.outputs.get('desktop')!;
    }
    return out;
  }

  getOutput(target: PlaybackTarget): AudioOutput | undefined {
    return this.outputs.get(target);
  }

  getInput(): AudioInput {
    return this.input;
  }

  /**
   * Switch the active playback target (Discord <-> Desktop <-> Virtual Output).
   * Preserves queue, current track, volume, and DJ state.
   */
  async switchTarget(newTarget: PlaybackTarget): Promise<void> {
    if (this.activeTarget === newTarget) return;

    const previousTarget = this.activeTarget;
    const currentOutput = this.getActiveOutput();

    // Stop previous output
    await currentOutput.stop();

    this.activeTarget = newTarget;
    const newOutput = this.getActiveOutput();

    this.emit('targetChanged', newTarget, previousTarget);
  }

  /**
   * Select the audio output device for the active target.
   */
  async setOutputDevice(deviceId: string): Promise<void> {
    const active = this.getActiveOutput();
    await active.setDevice(deviceId);
    this.emit('outputDeviceChanged', deviceId, this.activeTarget);
  }

  /**
   * Select the audio input device.
   */
  async setInputDevice(deviceId: string): Promise<void> {
    await this.input.setDevice(deviceId);
    this.emit('inputDeviceChanged', deviceId);
  }

  /**
   * Set monitoring / loopback mode (Requirement 12).
   */
  setMonitoring(enabled: boolean, monitorDeviceId?: string): { success: boolean; error?: string } {
    const desktop = this.outputs.get('desktop');
    if (desktop instanceof DesktopAudioOutput) {
      const res = desktop.setMonitoring(enabled, monitorDeviceId);
      if (res.success) {
        this.emit('monitoringChanged', enabled, monitorDeviceId || null);
      }
      return res;
    }
    return { success: false, error: 'Monitoring not supported on active adapter' };
  }

  /**
   * Get all enumerated output and input devices.
   */
  async getAllDevices(): Promise<{
    outputs: AudioDevice[];
    inputs: AudioDevice[];
    virtualOutputs: AudioDevice[];
  }> {
    const activeOut = this.getActiveOutput();
    const outputs = await activeOut.getDevices();
    const inputs = await this.input.getDevices();

    const virtualOut = this.outputs.get('virtual');
    let virtualOutputs: AudioDevice[] = [];
    if (virtualOut instanceof VirtualAudioOutput) {
      virtualOutputs = await virtualOut.getVirtualDevices();
    }

    return { outputs, inputs, virtualOutputs };
  }

  /**
   * Retrieve authoritative audio routing state snapshot.
   */
  async getState(): Promise<AudioRoutingState> {
    const activeOut = this.getActiveOutput();
    const outputs = await activeOut.getDevices();
    const inputs = await this.input.getDevices();

    let monitoringEnabled = false;
    let monitorDeviceId = '';

    const desktop = this.outputs.get('desktop');
    if (desktop instanceof DesktopAudioOutput) {
      const mon = desktop.getMonitoringStatus();
      monitoringEnabled = mon.enabled;
      monitorDeviceId = mon.monitorDeviceId || '';
    }

    return {
      target: this.activeTarget,
      outputDeviceId: activeOut.getActiveDeviceId() || '',
      inputDeviceId: this.input.getActiveDeviceId() || '',
      monitoringEnabled,
      monitorDeviceId,
      activeOutputs: outputs,
      activeInputs: inputs,
    };
  }

  async dispose(): Promise<void> {
    for (const output of this.outputs.values()) {
      await output.dispose();
    }
    await this.input.dispose();
    this.removeAllListeners();
  }
}
