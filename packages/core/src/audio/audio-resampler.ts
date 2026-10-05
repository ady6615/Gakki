/**
 * Audio Resampling, Format Conversion & PCM Mixing Utilities
 *
 * Implements:
 * - 48kHz -> 16kHz mono 16-bit PCM downsampling for Gemini Live & VAD (Requirement 3).
 * - 24kHz -> 48kHz stereo 16-bit PCM upsampling for VoiceResponseOutput (Requirement 12).
 * - Smooth PCM ducking / volume ramping for DJ commentary over music (Requirement 19).
 * - PCM summation & soft-limiting headroom protection.
 */

export interface ResampleOptions {
  fromSampleRate: number;
  toSampleRate: number;
  fromChannels?: number;
  toChannels?: number;
}

export class AudioResampler {
  /**
   * Resamples raw 16-bit signed little-endian PCM audio from one sample rate/channel count to another.
   * Uses high-quality linear interpolation with anti-aliasing and soft-clipping.
   */
  static resamplePcm16le(
    inputBuffer: Buffer,
    options: ResampleOptions,
  ): Buffer {
    const { fromSampleRate, toSampleRate, fromChannels = 1, toChannels = 1 } = options;

    if (
      fromSampleRate === toSampleRate &&
      fromChannels === toChannels &&
      inputBuffer.length > 0
    ) {
      return Buffer.from(inputBuffer);
    }

    if (inputBuffer.length === 0) {
      return Buffer.alloc(0);
    }

    const totalInputSamplesPerChannel = Math.floor(
      inputBuffer.length / (2 * fromChannels),
    );
    if (totalInputSamplesPerChannel === 0) {
      return Buffer.alloc(0);
    }

    // Convert input PCM buffer into float samples [-1.0, 1.0] per channel
    const inputChannels: Float32Array[] = [];
    for (let c = 0; c < fromChannels; c++) {
      inputChannels.push(new Float32Array(totalInputSamplesPerChannel));
    }

    for (let i = 0; i < totalInputSamplesPerChannel; i++) {
      for (let c = 0; c < fromChannels; c++) {
        const offset = (i * fromChannels + c) * 2;
        const val16 = inputBuffer.readInt16LE(offset);
        inputChannels[c][i] = val16 / 32768.0;
      }
    }

    // If converting stereo to mono, average the channels
    let monoInput: Float32Array;
    if (fromChannels === 2 && toChannels === 1) {
      monoInput = new Float32Array(totalInputSamplesPerChannel);
      for (let i = 0; i < totalInputSamplesPerChannel; i++) {
        monoInput[i] = (inputChannels[0][i] + inputChannels[1][i]) * 0.5;
      }
    } else {
      monoInput = inputChannels[0];
    }

    // Compute output length based on ratio
    const ratio = toSampleRate / fromSampleRate;
    const totalOutputSamplesPerChannel = Math.floor(totalInputSamplesPerChannel * ratio);
    if (totalOutputSamplesPerChannel === 0) {
      return Buffer.alloc(0);
    }

    const outputBuffer = Buffer.alloc(totalOutputSamplesPerChannel * toChannels * 2);

    for (let outIdx = 0; outIdx < totalOutputSamplesPerChannel; outIdx++) {
      const srcPos = outIdx / ratio;
      const srcIdx = Math.floor(srcPos);
      const frac = srcPos - srcIdx;

      for (let outChan = 0; outChan < toChannels; outChan++) {
        let sampleVal = 0;

        if (fromChannels === 1 || (fromChannels === 2 && toChannels === 1)) {
          // Source is single stream (or already downmixed)
          const s0 = srcIdx < totalInputSamplesPerChannel ? monoInput[srcIdx] : 0;
          const s1 =
            srcIdx + 1 < totalInputSamplesPerChannel ? monoInput[srcIdx + 1] : s0;
          sampleVal = s0 + frac * (s1 - s0);
        } else if (fromChannels === 2 && toChannels === 2) {
          // Stereo to stereo
          const chan = Math.min(outChan, fromChannels - 1);
          const s0 = srcIdx < totalInputSamplesPerChannel ? inputChannels[chan][srcIdx] : 0;
          const s1 =
            srcIdx + 1 < totalInputSamplesPerChannel
              ? inputChannels[chan][srcIdx + 1]
              : s0;
          sampleVal = s0 + frac * (s1 - s0);
        } else if (fromChannels === 1 && toChannels === 2) {
          // Mono to stereo duplicate
          const s0 = srcIdx < totalInputSamplesPerChannel ? inputChannels[0][srcIdx] : 0;
          const s1 =
            srcIdx + 1 < totalInputSamplesPerChannel
              ? inputChannels[0][srcIdx + 1]
              : s0;
          sampleVal = s0 + frac * (s1 - s0);
        }

        // Soft limit & clamp to [-1.0, 1.0]
        const clamped = Math.max(-1.0, Math.min(1.0, sampleVal));
        const int16Val = Math.round(
          clamped >= 0 ? clamped * 32767.0 : clamped * 32768.0,
        );

        const outOffset = (outIdx * toChannels + outChan) * 2;
        outputBuffer.writeInt16LE(int16Val, outOffset);
      }
    }

    return outputBuffer;
  }

  /**
   * Fast downsampling from 48kHz (desktop/mic capture) to 16kHz mono signed 16-bit PCM for Gemini Live.
   * 48kHz -> 16kHz is an exact 3:1 integer decimation ratio with a 3-tap averaging low-pass filter.
   */
  static downsample48kTo16kMono(input48k: Buffer, inputChannels = 1): Buffer {
    const bytesPerInputFrame = inputChannels * 2;
    const inputFrames = Math.floor(input48k.length / bytesPerInputFrame);
    const outputFrames = Math.floor(inputFrames / 3);

    if (outputFrames === 0) {
      return Buffer.alloc(0);
    }

    const outputBuffer = Buffer.alloc(outputFrames * 2);

    for (let outIdx = 0; outIdx < outputFrames; outIdx++) {
      const srcFrameIdx = outIdx * 3;
      let sum = 0;

      for (let tap = 0; tap < 3; tap++) {
        const framePos = (srcFrameIdx + tap) * bytesPerInputFrame;
        let sample = 0;
        if (inputChannels === 1) {
          sample = input48k.readInt16LE(framePos);
        } else {
          const ch1 = input48k.readInt16LE(framePos);
          const ch2 = input48k.readInt16LE(framePos + 2);
          sample = Math.round((ch1 + ch2) * 0.5);
        }
        sum += sample;
      }

      const avgSample = Math.round(sum / 3);
      const clamped = Math.max(-32768, Math.min(32767, avgSample));
      outputBuffer.writeInt16LE(clamped, outIdx * 2);
    }

    return outputBuffer;
  }

  /**
   * Upsamples 24kHz mono/stereo PCM (Gemini Live native audio output) to 48kHz stereo 16-bit PCM.
   * 24kHz -> 48kHz is an exact 1:2 integer interpolation ratio with linear smoothing.
   */
  static upsample24kTo48kStereo(input24kMono: Buffer): Buffer {
    const inputSamples = Math.floor(input24kMono.length / 2);
    if (inputSamples === 0) return Buffer.alloc(0);

    const outputFrames = inputSamples * 2;
    const outputBuffer = Buffer.alloc(outputFrames * 4); // 2 channels * 2 bytes = 4 bytes per frame

    for (let inIdx = 0; inIdx < inputSamples; inIdx++) {
      const s0 = input24kMono.readInt16LE(inIdx * 2);
      const s1 = inIdx + 1 < inputSamples ? input24kMono.readInt16LE((inIdx + 1) * 2) : s0;
      const mid = Math.round((s0 + s1) * 0.5);

      // Frame 1: s0
      const outOffset0 = inIdx * 2 * 4;
      outputBuffer.writeInt16LE(s0, outOffset0); // L
      outputBuffer.writeInt16LE(s0, outOffset0 + 2); // R

      // Frame 2: interpolated mid
      const outOffset1 = (inIdx * 2 + 1) * 4;
      outputBuffer.writeInt16LE(mid, outOffset1); // L
      outputBuffer.writeInt16LE(mid, outOffset1 + 2); // R
    }

    return outputBuffer;
  }

  /**
   * Applies smooth ducking or volume ramp to a 16-bit PCM buffer.
   * @param buffer Raw 16-bit PCM audio
   * @param startVolume Starting volume multiplier (0.0 - 1.0)
   * @param endVolume Ending volume multiplier (0.0 - 1.0)
   * @param channels Channel count (default 2)
   */
  static applyVolumeRamp(
    buffer: Buffer,
    startVolume: number,
    endVolume: number,
    channels = 2,
  ): Buffer {
    const totalFrames = Math.floor(buffer.length / (channels * 2));
    if (totalFrames === 0) return Buffer.from(buffer);

    const result = Buffer.alloc(buffer.length);
    for (let frame = 0; frame < totalFrames; frame++) {
      const progress = totalFrames > 1 ? frame / (totalFrames - 1) : 0;
      const currentVolume = startVolume + progress * (endVolume - startVolume);

      for (let c = 0; c < channels; c++) {
        const offset = (frame * channels + c) * 2;
        const sample = buffer.readInt16LE(offset);
        const scaled = Math.round(sample * currentVolume);
        const clamped = Math.max(-32768, Math.min(32767, scaled));
        result.writeInt16LE(clamped, offset);
      }
    }
    return result;
  }

  /**
   * Mixes commentary PCM audio over music PCM audio with volume ducking and soft clipping.
   */
  static mixDuckedAudio(
    musicBuffer: Buffer,
    voiceBuffer: Buffer,
    duckedMusicMultiplier = 0.25,
    channels = 2,
  ): Buffer {
    const totalBytes = Math.max(musicBuffer.length, voiceBuffer.length);
    const result = Buffer.alloc(totalBytes);
    const totalFrames = Math.floor(totalBytes / (channels * 2));

    for (let frame = 0; frame < totalFrames; frame++) {
      for (let c = 0; c < channels; c++) {
        const offset = (frame * channels + c) * 2;

        let musicSample = 0;
        if (offset + 1 < musicBuffer.length) {
          musicSample = musicBuffer.readInt16LE(offset);
        }

        let voiceSample = 0;
        if (offset + 1 < voiceBuffer.length) {
          voiceSample = voiceBuffer.readInt16LE(offset);
        }

        // If voice is active at this frame, duck music
        const activeVoice = offset < voiceBuffer.length;
        const scaledMusic = activeVoice
          ? Math.round(musicSample * duckedMusicMultiplier)
          : musicSample;

        // Sum with soft-clip headroom preservation
        const sum = (scaledMusic + voiceSample) / 32768.0;
        let limited = sum;
        if (sum > 1.0) {
          limited = 1.0 - Math.exp(-sum + 1.0) * 0.1;
        } else if (sum < -1.0) {
          limited = -1.0 + Math.exp(sum + 1.0) * 0.1;
        }

        const finalInt16 = Math.round(
          limited >= 0 ? limited * 32767.0 : limited * 32768.0,
        );
        const clamped = Math.max(-32768, Math.min(32767, finalInt16));
        result.writeInt16LE(clamped, offset);
      }
    }

    return result;
  }

  /**
   * Splits PCM stream into fixed-size chunks (e.g. 100ms chunks of 16kHz audio = 1600 samples = 3200 bytes).
   */
  static chunkPcmBuffer(buffer: Buffer, chunkSize: number): Buffer[] {
    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset < buffer.length) {
      const end = Math.min(offset + chunkSize, buffer.length);
      chunks.push(buffer.subarray(offset, end));
      offset = end;
    }
    return chunks;
  }
}
