import * as fs from 'node:fs';
import * as path from 'node:path';

export interface WavHeaderInfo {
  sampleRate: number;
  channels: number;
  numChannels: number;
  bitsPerSample: number;
  bitDepth: number;
  byteRate: number;
  blockAlign: number;
  dataSize: number;
  dataLength: number;
  dataOffset: number;
  durationMs: number;
}

export interface WavHeaderOptions {
  dataSizeBytes?: number;
  dataLength?: number;
  sampleRate?: number;
  channels?: number;
  numChannels?: number;
  bitsPerSample?: number;
  bitDepth?: number;
}

/**
 * Construct a 44-byte RIFF WAVE header for 16-bit PCM audio.
 */
export function createWavHeader(
  dataSizeBytesOrOptions: number | WavHeaderOptions,
  sampleRate: number = 48000,
  channels: number = 2,
  bitsPerSample: number = 16
): Buffer {
  let dataSizeBytes: number;
  if (typeof dataSizeBytesOrOptions === 'object') {
    const opts = dataSizeBytesOrOptions;
    dataSizeBytes = opts.dataSizeBytes ?? opts.dataLength ?? 0;
    sampleRate = opts.sampleRate ?? 48000;
    channels = opts.channels ?? opts.numChannels ?? 2;
    bitsPerSample = opts.bitsPerSample ?? opts.bitDepth ?? 16;
  } else {
    dataSizeBytes = dataSizeBytesOrOptions;
  }

  const header = Buffer.alloc(44);
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const totalFileSize = dataSizeBytes + 36;

  // RIFF Chunk Descriptor
  header.write('RIFF', 0);
  header.writeUInt32LE(totalFileSize, 4);
  header.write('WAVE', 8);

  // 'fmt ' Sub-chunk
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // Subchunk1Size for PCM
  header.writeUInt16LE(1, 20);  // AudioFormat: 1 = PCM (Linear quantization)
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);

  // 'data' Sub-chunk
  header.write('data', 36);
  header.writeUInt32LE(dataSizeBytes, 40);

  return header;
}

/**
 * Parse an existing WAV file header.
 */
export function parseWavHeader(buffer: Buffer): WavHeaderInfo {
  if (buffer.length < 44) {
    throw new Error('Buffer too small to be a valid WAV file');
  }

  const riff = buffer.toString('ascii', 0, 4);
  const wave = buffer.toString('ascii', 8, 12);
  if (riff !== 'RIFF' || wave !== 'WAVE') {
    throw new Error('Invalid WAV file magic header');
  }

  let offset = 12;
  let fmtFound = false;
  let sampleRate = 48000;
  let channels = 2;
  let bitsPerSample = 16;
  let byteRate = sampleRate * channels * 2;
  let blockAlign = channels * 2;
  let dataSize = 0;
  let dataOffset = 44;

  while (offset <= buffer.length - 8) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);

    if (chunkId === 'fmt ') {
      channels = buffer.readUInt16LE(offset + 10);
      sampleRate = buffer.readUInt32LE(offset + 12);
      byteRate = buffer.readUInt32LE(offset + 16);
      blockAlign = buffer.readUInt16LE(offset + 20);
      bitsPerSample = buffer.readUInt16LE(offset + 22);
      fmtFound = true;
      offset += 8 + chunkSize;
    } else if (chunkId === 'data') {
      dataSize = chunkSize;
      dataOffset = offset + 8;
      break;
    } else {
      offset += 8 + chunkSize;
    }
  }

  if (!fmtFound) {
    throw new Error('Missing fmt chunk in WAV file');
  }

  const durationMs = byteRate > 0 ? Math.round((dataSize / byteRate) * 1000) : 0;

  return {
    sampleRate,
    channels,
    numChannels: channels,
    bitsPerSample,
    bitDepth: bitsPerSample,
    byteRate,
    blockAlign,
    dataSize,
    dataLength: dataSize,
    dataOffset,
    durationMs,
  };
}

/**
 * Generate a zero-filled PCM silence buffer of given duration.
 */
export function createSilenceBuffer(
  durationMs: number,
  sampleRate: number = 48000,
  channels: number = 2,
  bitsPerSample: number = 16
): Buffer {
  const bytesPerSec = (sampleRate * channels * bitsPerSample) / 8;
  const numBytes = Math.floor((durationMs / 1000) * bytesPerSec);
  // Ensure even alignment for sample boundaries
  const alignedBytes = numBytes - (numBytes % ((channels * bitsPerSample) / 8));
  return Buffer.alloc(Math.max(0, alignedBytes));
}

/**
 * Wrap raw PCM data in a complete WAV file buffer (and optionally write to disk).
 */
export function pcmToWav(
  pcmBuffer: Buffer,
  outputPathOrSampleRate: string | number = 48000,
  channels: number = 2,
  bitsPerSample: number = 16
): Buffer {
  let outputPath: string | undefined;
  let sampleRate = 48000;
  if (typeof outputPathOrSampleRate === 'string') {
    outputPath = outputPathOrSampleRate;
  } else if (typeof outputPathOrSampleRate === 'number') {
    sampleRate = outputPathOrSampleRate;
  }
  const header = createWavHeader(pcmBuffer.length, sampleRate, channels, bitsPerSample);
  const wavBuf = Buffer.concat([header, pcmBuffer]);
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, wavBuf);
  }
  return wavBuf;
}

/**
 * Extract raw PCM data from a WAV file.
 */
export function extractPcmFromWav(wavBuffer: Buffer): { pcm: Buffer; header: WavHeaderInfo } {
  const header = parseWavHeader(wavBuffer);
  const pcm = wavBuffer.subarray(header.dataOffset, header.dataOffset + header.dataSize);
  return { pcm, header };
}
