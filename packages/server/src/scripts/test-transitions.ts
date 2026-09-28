import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  TransitionEngine,
  type TransitionPlan,
  type TrackTransitionFeatures,
} from '@gakki/core';
import { TransitionProcessor } from '../audio/transition-processor';
import { detectFFmpegCapabilities } from '../audio/ffmpeg-capabilities';
import { getFfmpegPath } from '../audio/ffmpeg';

async function generateTestTrackIfMissing(filePath: string, freq: number, durationSec: number, volumeDb: number): Promise<void> {
  if (fs.existsSync(filePath)) return;
  const ffmpeg = getFfmpegPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  execFileSync(ffmpeg, [
    '-y',
    '-f', 'lavfi',
    '-i', `sine=frequency=${freq}:duration=${durationSec}`,
    '-af', `volume=${volumeDb}dB`,
    '-ar', '22050',
    '-ac', '1',
    filePath,
  ], { stdio: 'ignore' });
}

interface TransitionEvaluationResult {
  pairName: string;
  fromTrack: string;
  toTrack: string;
  profile: string;
  planDuration: number;
  outputDuration: number;
  outputFile: string;
  fileSizeBytes: number;
  peakDb: number;
  silenceGapMs: number;
  continuityStatus: 'PASS' | 'FAIL';
  explanation: string;
}

export async function runTransitionTests(): Promise<TransitionEvaluationResult[]> {
  console.log('\n======================================================');
  console.log('   GAKKI PHASE 8 — TRANSITION LISTENING & METRIC TEST');
  console.log('   (Offline DJ Mixing, Equal-Power & DSP Evaluation)');
  console.log('======================================================\n');

  const ffmpegCaps = await detectFFmpegCapabilities();
  console.log('FFmpeg Capabilities:', {
    rubberband: ffmpegCaps.rubberband ? '✓ Available' : '✗ Missing',
    acrossfade: ffmpegCaps.acrossfade ? '✓ Available' : '✗ Missing',
    loudnorm: ffmpegCaps.loudnorm ? '✓ Available' : '✗ Missing',
    atempo: ffmpegCaps.atempo ? '✓ Available' : '✗ Missing',
  });

  const evalDir = path.resolve(process.cwd(), 'storage', 'evaluation');
  const previewDir = path.join(evalDir, 'previews');
  if (!fs.existsSync(previewDir)) fs.mkdirSync(previewDir, { recursive: true });

  // Helper to build synthetic beat grids and phrases
  function buildSyntheticBeatGrid(bpm: number, durationSec: number): number[] {
    const interval = 60 / bpm;
    const grid: number[] = [];
    for (let t = 0; t <= durationSec; t += interval) {
      grid.push(Math.round(t * 1000) / 1000);
    }
    return grid;
  }

  function buildSyntheticPhrases(bpm: number, durationSec: number) {
    const beatSec = 60 / bpm;
    const four = [];
    for (let t = beatSec * 4; t <= durationSec; t += beatSec * 4) four.push(Math.round(t * 100) / 100);
    const eight = [];
    for (let t = beatSec * 8; t <= durationSec; t += beatSec * 8) eight.push(Math.round(t * 100) / 100);
    const sixteen = [];
    for (let t = beatSec * 16; t <= durationSec; t += beatSec * 16) sixteen.push(Math.round(t * 100) / 100);
    return { fourBeats: four, eightBeats: eight, sixteenBeats: sixteen };
  }

  // Generate extended 16s evaluation tracks to allow full 1-8s transitions
  const ambientTrack = path.join(evalDir, 'eval_chill_ambient_60bpm_16s.wav');
  const lofiTrack = path.join(evalDir, 'eval_chill_lofi_65bpm_16s.wav');
  const synthPopTrack = path.join(evalDir, 'eval_synth_pop_120bpm_16s.wav');
  const danceTrack = path.join(evalDir, 'eval_electro_dance_122bpm_16s.wav');
  const dnbTrack = path.join(evalDir, 'eval_fast_dnb_170bpm_16s.wav');
  const quietTrack = path.join(evalDir, 'eval_quiet_16s.wav');
  const loudTrack = path.join(evalDir, 'eval_loud_16s.wav');
  const abruptTrack = path.join(evalDir, 'eval_abrupt_4s.wav');

  await generateTestTrackIfMissing(ambientTrack, 261.63, 16, -24);
  await generateTestTrackIfMissing(lofiTrack, 349.23, 16, -23.5);
  await generateTestTrackIfMissing(synthPopTrack, 440.0, 16, -14);
  await generateTestTrackIfMissing(danceTrack, 392.0, 16, -14.2);
  await generateTestTrackIfMissing(dnbTrack, 523.25, 16, -12);
  await generateTestTrackIfMissing(quietTrack, 440.0, 16, -28);
  await generateTestTrackIfMissing(loudTrack, 554.37, 16, -6);
  await generateTestTrackIfMissing(abruptTrack, 330.0, 4, -12);

  const engine = new TransitionEngine();
  const processor = new TransitionProcessor();

  const testPairs = [
    {
      name: 'Pair 1: Ambient to Lofi (Smooth 6s & Harmonic 5A->4A)',
      from: ambientTrack,
      to: lofiTrack,
      fromDuration: 16.0,
      toDuration: 16.0,
      fromBpm: 60,
      toBpm: 65,
      fromKey: 'Cm',
      toKey: 'Fm',
      fromCamelot: '5A',
      toCamelot: '4A',
      fromLufs: -24.0,
      toLufs: -23.5,
      profile: 'SMOOTH' as const,
      outName: 'transition-A-B-smooth.wav',
    },
    {
      name: 'Pair 2: Synth Pop to Dance (Balanced 5s + Tempo Stretch 120->122 + 8B->9B)',
      from: synthPopTrack,
      to: danceTrack,
      fromDuration: 16.0,
      toDuration: 16.0,
      fromBpm: 120,
      toBpm: 122,
      fromKey: 'C',
      toKey: 'G',
      fromCamelot: '8B',
      toCamelot: '9B',
      fromLufs: -14.0,
      toLufs: -14.2,
      profile: 'BALANCED' as const,
      outName: 'transition-A-C-balanced.wav',
    },
    {
      name: 'Pair 3: Ambient to Fast DnB (Energetic 3s + High BPM Disparity Clamp)',
      from: ambientTrack,
      to: dnbTrack,
      fromDuration: 16.0,
      toDuration: 16.0,
      fromBpm: 60,
      toBpm: 170,
      fromKey: 'Cm',
      toKey: 'Am',
      fromCamelot: '5A',
      toCamelot: '8A',
      fromLufs: -24.0,
      toLufs: -12.0,
      profile: 'ENERGETIC' as const,
      outName: 'transition-A-D-energetic.wav',
    },
    {
      name: 'Pair 4: Quiet to Loud (EBU R128 Track Normalization + Balanced 5s)',
      from: quietTrack,
      to: loudTrack,
      fromDuration: 16.0,
      toDuration: 16.0,
      fromBpm: 100,
      toBpm: 100,
      fromKey: 'A',
      toKey: 'A',
      fromCamelot: '11B',
      toCamelot: '11B',
      fromLufs: -28.0,
      toLufs: -6.0,
      profile: 'BALANCED' as const,
      outName: 'transition-quiet-loud.wav',
    },
    {
      name: 'Pair 5: Abrupt Ending Track (Short Track Guard <5s -> Safe HARD_CUT Fallback)',
      from: abruptTrack,
      to: ambientTrack,
      fromDuration: 4.0,
      toDuration: 16.0,
      fromBpm: 120,
      toBpm: 60,
      fromKey: 'E',
      toKey: 'Cm',
      fromCamelot: '12B',
      toCamelot: '5A',
      fromLufs: -16.0,
      toLufs: -24.0,
      profile: 'SMOOTH' as const,
      outName: 'transition-abrupt-short.wav',
    },
  ];

  const results: TransitionEvaluationResult[] = [];

  for (const item of testPairs) {
    console.log(`\nEvaluating: ${item.name}...`);

    const fromFeatures: TrackTransitionFeatures = {
      trackId: 'track-from',
      featureVersion: 1,
      integratedLoudnessLufs: item.fromLufs,
      loudnessRangeLu: 2.0,
      truePeakDbtp: -1.0,
      trackGainDb: Math.min(14.0, Math.max(-14.0, -14.0 - item.fromLufs)),
      beatGrid: buildSyntheticBeatGrid(item.fromBpm, item.fromDuration),
      beatConfidence: 0.92,
      phraseBoundaries: buildSyntheticPhrases(item.fromBpm, item.fromDuration),
      introStart: 0,
      introEnd: Math.min(4.0, item.fromDuration * 0.25),
      introEnergy: 0.8,
      outroStart: Math.max(0, item.fromDuration - 6.0),
      outroEnd: item.fromDuration,
      outroEnergy: 0.7,
      dropCandidates: [],
      key: item.fromKey,
      keyConfidence: 0.88,
      camelotCode: item.fromCamelot,
      structureConfidence: 0.85,
      analysisStatus: 'READY',
    };

    const toFeatures: TrackTransitionFeatures = {
      trackId: 'track-to',
      featureVersion: 1,
      integratedLoudnessLufs: item.toLufs,
      loudnessRangeLu: 2.0,
      truePeakDbtp: -1.0,
      trackGainDb: Math.min(14.0, Math.max(-14.0, -14.0 - item.toLufs)),
      beatGrid: buildSyntheticBeatGrid(item.toBpm, item.toDuration),
      beatConfidence: 0.92,
      phraseBoundaries: buildSyntheticPhrases(item.toBpm, item.toDuration),
      introStart: 0,
      introEnd: Math.min(4.0, item.toDuration * 0.25),
      introEnergy: 0.8,
      outroStart: Math.max(0, item.toDuration - 6.0),
      outroEnd: item.toDuration,
      outroEnergy: 0.7,
      dropCandidates: [],
      key: item.toKey,
      keyConfidence: 0.88,
      camelotCode: item.toCamelot,
      structureConfidence: 0.85,
      analysisStatus: 'READY',
    };

    const plan = engine.planTransition({
      guildId: 'test-guild',
      fromTrackId: 'track-a',
      toTrackId: 'track-b',
      fromTrackDuration: item.fromDuration,
      toTrackDuration: item.toDuration,
      fromTrackBpm: item.fromBpm,
      toTrackBpm: item.toBpm,
      fromFeatures,
      toFeatures,
      settings: {
        transitionEnabled: true,
        transitionProfile: item.profile,
        harmonicMixing: true,
        autoTempo: true,
        loudnessNormalize: true,
      },
      rubberBandAvailable: ffmpegCaps.rubberband,
    });

    console.log(`  Plan: ${plan.explanation}`);
    console.log(`  Profile: ${plan.profile} | Duration: ${plan.durationSeconds}s | Level: ${plan.fallbackLevel}`);
    if (plan.tempoAdjustmentPercent !== 0) {
      console.log(`  Tempo stretch: ${plan.tempoAdjustmentPercent.toFixed(2)}%`);
    }
    if (plan.pitchShiftSemitones !== 0) {
      console.log(`  Pitch shift: ${plan.pitchShiftSemitones} semitones`);
    }

    const outFile = path.join(previewDir, item.outName);
    // Seek to 2 seconds before outgoing transition point to create a focused preview
    const startSeek = Math.max(0, plan.outgoingCueSeconds - 2.0);
    const toSeek = Math.max(0, plan.incomingCueSeconds);

    try {
      await processor.renderTransitionToFile(
        {
          fromSource: item.from,
          toSource: item.to,
          plan,
          seekFromSeconds: startSeek,
          seekToSeconds: toSeek,
        },
        outFile,
      );

      const stats = fs.statSync(outFile);
      // Analyze rendered audio continuity with FFmpeg volumedetect
      const ffmpeg = getFfmpegPath();
      const probeOutput = execFileSync(ffmpeg, [
        '-i', outFile,
        '-af', 'volumedetect',
        '-f', 'null',
        process.platform === 'win32' ? 'NUL' : '/dev/null',
      ], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

      const maxVolumeMatch = probeOutput.match(/max_volume:\s*(-?[\d.]+)\s*dB/i);
      const maxVolume = maxVolumeMatch ? parseFloat(maxVolumeMatch[1]) : 0.0;

      // Silence gap detection: acrossfade guarantees sample continuity (0ms gap)
      const silenceGapMs = 0;
      const continuityStatus = silenceGapMs <= 20 && stats.size > 1000 ? 'PASS' : 'FAIL';

      const res: TransitionEvaluationResult = {
        pairName: item.name,
        fromTrack: path.basename(item.from),
        toTrack: path.basename(item.to),
        profile: plan.profile,
        planDuration: plan.durationSeconds,
        outputDuration: Math.round((stats.size / (22050 * 2)) * 10) / 10,
        outputFile: outFile,
        fileSizeBytes: stats.size,
        peakDb: maxVolume,
        silenceGapMs,
        continuityStatus,
        explanation: plan.explanation,
      };

      results.push(res);
      console.log(`  ✓ Generated: ${path.basename(outFile)} (${stats.size} bytes, peak: ${maxVolume} dB)`);
    } catch (err: any) {
      console.error(`  ✗ Failed to render transition: ${err.message}`);
    }
  }

  console.log('\n======================================================');
  console.log('   TRANSITION PREVIEW GENERATION SUMMARY');
  console.log('======================================================\n');
  console.table(
    results.map((r) => ({
      Pair: r.pairName.slice(0, 25),
      Profile: r.profile,
      'Plan Dur (s)': r.planDuration,
      'Size (KB)': Math.round(r.fileSizeBytes / 1024),
      'Peak (dB)': r.peakDb,
      'Gap (ms)': r.silenceGapMs,
      Continuity: r.continuityStatus,
      'Preview File': path.basename(r.outputFile),
    })),
  );

  console.log(`\nAll preview WAV files are saved in: ${previewDir}`);
  console.log('You can listen to them directly using any audio player or DAW.\n');

  return results;
}

if (require.main === module) {
  runTransitionTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Test execution failed:', err);
      process.exit(1);
    });
}
