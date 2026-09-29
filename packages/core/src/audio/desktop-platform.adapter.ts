import type { Readable } from 'node:stream';
import type {
  VoicePlatformAdapter,
  AdapterPlayOptions,
} from '../types/platform';
import type {
  VoicePlatformState,
  PlaybackStatus,
  VoiceConnectionStatus,
  AudioTrackInfo,
} from '../types/audio';
import type { AudioSource } from './audio-source';
import type { AudioFilterConfig } from '../types/queue';
import { DesktopAudioOutput } from './desktop-audio-output';
import { VirtualAudioOutput } from './virtual-audio-output';

type StateChangeListener = (state: VoicePlatformState) => void;
type ErrorListener = (guildId: string, error: Error) => void;
type TrackEndListener = (guildId: string) => void;

/**
 * Desktop Platform Voice Adapter.
 * Bridges Gakki's PlaybackManager with Desktop and Virtual OS Audio devices.
 * Enables full standalone music playback without requiring Discord.
 */
export class DesktopPlatformAdapter implements VoicePlatformAdapter {
  readonly platform = 'desktop' as const;

  private voiceState: VoiceConnectionStatus = 'CONNECTED';
  private playerState: PlaybackStatus = 'IDLE';
  private currentTrack: AudioTrackInfo | null = null;
  private currentVolume = 100;
  private currentStream: Readable | null = null;
  private currentGuildId = 'desktop-local';
  private playbackStartTime: number = 0;
  private pausedAtTime: number = 0;
  private elapsedSeconds: number = 0;

  private readonly stateListeners = new Set<StateChangeListener>();
  private readonly errorListeners = new Set<ErrorListener>();
  private readonly trackEndListeners = new Set<TrackEndListener>();

  public readonly desktopOutput: DesktopAudioOutput;
  public readonly virtualOutput: VirtualAudioOutput;

  constructor(options?: {
    desktopOutput?: DesktopAudioOutput;
    virtualOutput?: VirtualAudioOutput;
  }) {
    this.desktopOutput = options?.desktopOutput || new DesktopAudioOutput();
    this.virtualOutput = options?.virtualOutput || new VirtualAudioOutput();

    // Listen to device fallbacks
    this.desktopOutput.on('deviceFallback', (failed, fallback, reason) => {
      this.emitState();
    });
  }

  async joinVoice(guildId: string, channelId: string, options?: unknown): Promise<void> {
    this.currentGuildId = guildId || 'desktop-local';
    this.voiceState = 'CONNECTED';
    this.emitState();
  }

  async leaveVoice(guildId: string): Promise<void> {
    this.stop(guildId);
    this.voiceState = 'DISCONNECTED';
    this.emitState();
  }

  getVoiceStatus(_guildId: string): VoiceConnectionStatus {
    return this.voiceState;
  }

  async play(guildId: string, source: AudioSource, options?: AdapterPlayOptions): Promise<void> {
    this.currentGuildId = guildId || 'desktop-local';
    try {
      await source.validate();
      const meta = await source.getMetadata();
      const rawStream = await source.getStream();

      this.currentTrack = {
        name: meta.title,
        duration: meta.duration ?? null,
        artist: meta.artist ?? null,
        filePath: source.identifier,
        sourceType: source.sourceType,
      };

      if (options?.volume !== undefined) {
        this.setVolume(guildId, options.volume);
      }

      this.currentStream = rawStream;
      this.playerState = 'PLAYING';
      this.playbackStartTime = Date.now();
      this.pausedAtTime = 0;
      this.elapsedSeconds = options?.seekSeconds || 0;

      // Pipe to desktop output
      await this.desktopOutput.start({
        stream: rawStream,
        format: {
          sampleRate: 48000,
          channels: 2,
          bitDepth: 16,
          encoding: 'pcm_s16le',
        },
      });

      // Track end listener
      rawStream.once('end', () => {
        this.handleTrackEnded();
      });

      rawStream.once('error', (err) => {
        this.handleError(err);
      });

      this.emitState();
    } catch (err: any) {
      this.playerState = 'ERROR';
      this.emitState();
      this.handleError(err);
      throw err;
    }
  }

  pause(_guildId: string): boolean {
    if (this.playerState !== 'PLAYING') return false;
    this.playerState = 'PAUSED';
    this.pausedAtTime = Date.now();
    this.desktopOutput.stop();
    this.emitState();
    return true;
  }

  resume(_guildId: string): boolean {
    if (this.playerState !== 'PAUSED') return false;
    this.playerState = 'PLAYING';
    if (this.pausedAtTime > 0) {
      this.playbackStartTime += Date.now() - this.pausedAtTime;
      this.pausedAtTime = 0;
    }
    if (this.currentStream) {
      this.desktopOutput.start({
        stream: this.currentStream,
        format: { sampleRate: 48000, channels: 2, bitDepth: 16, encoding: 'pcm_s16le' },
      });
    }
    this.emitState();
    return true;
  }

  stop(_guildId: string): boolean {
    this.playerState = 'IDLE';
    this.currentTrack = null;
    this.desktopOutput.stop();
    if (this.currentStream && 'destroy' in this.currentStream) {
      (this.currentStream as any).destroy();
    }
    this.currentStream = null;
    this.emitState();
    return true;
  }

  setVolume(_guildId: string, volume: number): void {
    this.currentVolume = Math.max(0, Math.min(200, volume));
    this.desktopOutput.setVolume(this.currentVolume);
  }

  getPlaybackDuration(_guildId: string): number {
    if (this.playerState === 'IDLE' || !this.currentTrack) return 0;
    if (this.playerState === 'PAUSED' && this.pausedAtTime > 0) {
      return this.elapsedSeconds + Math.floor((this.pausedAtTime - this.playbackStartTime) / 1000);
    }
    return this.elapsedSeconds + Math.floor((Date.now() - this.playbackStartTime) / 1000);
  }

  getHumanCount(_guildId: string): number {
    // Desktop user is always 1 listener
    return 1;
  }

  getPlaybackStatus(_guildId: string): PlaybackStatus {
    return this.playerState;
  }

  getCurrentTrack(_guildId: string): AudioTrackInfo | null {
    return this.currentTrack;
  }

  getState(_guildId?: string): VoicePlatformState {
    return {
      guildId: this.currentGuildId,
      voiceState: this.voiceState,
      playerState: this.playerState,
      track: this.currentTrack,
    };
  }

  onStateChange(listener: StateChangeListener): void {
    this.stateListeners.add(listener);
  }

  onError(listener: ErrorListener): void {
    this.errorListeners.add(listener);
  }

  onTrackEnd(listener: TrackEndListener): void {
    this.trackEndListeners.add(listener);
  }

  private handleTrackEnded(): void {
    this.playerState = 'IDLE';
    this.currentTrack = null;
    this.currentStream = null;
    this.emitState();

    for (const listener of this.trackEndListeners) {
      try {
        listener(this.currentGuildId);
      } catch (err) {
        // ignore
      }
    }
  }

  private handleError(error: Error): void {
    for (const listener of this.errorListeners) {
      try {
        listener(this.currentGuildId, error);
      } catch {
        // ignore
      }
    }
  }

  private emitState(): void {
    const state = this.getState();
    for (const listener of this.stateListeners) {
      try {
        listener(state);
      } catch {
        // ignore
      }
    }
  }
}
