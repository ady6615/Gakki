import { DesktopAudioOutput } from './desktop-audio-output';
import type { AudioDevice, PlaybackTarget } from '../types/audio';

/**
 * Virtual Audio Output Implementation.
 * Routes Gakki's audio engine stream into an OS virtual audio device / loopback cable
 * (such as VB-Audio Virtual Cable, VoiceMeeter, or BlackHole) so that other desktop
 * applications (Discord client, Google Meet, OBS) can receive it as a virtual mic.
 *
 * Adheres to:
 * - Requirement 10: Virtual audio output architecture & driver detection without automatic install.
 * - Requirement 11: System audio routing independent of Discord bot.
 */
export class VirtualAudioOutput extends DesktopAudioOutput {
  override readonly id = 'output-virtual';
  override readonly name = 'Virtual Audio Output (Cable / Loopback)';
  override readonly targetType: PlaybackTarget = 'virtual';

  private static readonly VIRTUAL_DEVICE_KEYWORDS = [
    'cable',
    'vb-audio',
    'voicemeeter',
    'virtual',
    'loopback',
    'blackhole',
    'soundflower',
  ];

  constructor(devices?: AudioDevice[]) {
    super(devices);
  }

  /**
   * Determine if a device name matches recognized virtual audio drivers.
   */
  static isVirtualDevice(name: string): boolean {
    const lower = name.toLowerCase();
    return VirtualAudioOutput.VIRTUAL_DEVICE_KEYWORDS.some((kw) => lower.includes(kw));
  }

  /**
   * Filter and return all detected virtual audio output devices.
   */
  async getVirtualDevices(): Promise<AudioDevice[]> {
    const all = await this.getDevices();
    return all.filter((d) => d.isVirtual || VirtualAudioOutput.isVirtualDevice(d.name));
  }

  /**
   * Scan system device list and mark virtual devices.
   */
  detectVirtualDevices(discoveredDevices: AudioDevice[]): {
    virtualCount: number;
    virtualDevices: AudioDevice[];
    instructionsNeeded: boolean;
  } {
    const enriched = discoveredDevices.map((d) => {
      const isVirt = VirtualAudioOutput.isVirtualDevice(d.name);
      return {
        ...d,
        isVirtual: isVirt,
      };
    });

    this.updateDevices(enriched);

    const virtuals = enriched.filter((d) => d.isVirtual);
    return {
      virtualCount: virtuals.length,
      virtualDevices: virtuals,
      instructionsNeeded: virtuals.length === 0,
    };
  }

  /**
   * Get manual setup documentation for users configuring virtual audio cables.
   */
  getManualSetupGuide(): string {
    return [
      '=== Virtual Audio Device Configuration Guide ===',
      '1. Install a virtual audio driver such as VB-Audio Cable (https://vb-audio.com/Cable/) or VoiceMeeter.',
      '2. Restart Gakki or refresh your audio device list.',
      '3. In Gakki Settings -> Output Device, select "CABLE Input (VB-Audio Virtual Cable)".',
      '4. In Discord, Google Meet, or OBS, select "CABLE Output (VB-Audio Virtual Cable)" as your Microphone / Input Device.',
      '5. Gakki will now route its pristine 48kHz audio directly into your meeting or streaming application without a bot!',
    ].join('\n');
  }
}
