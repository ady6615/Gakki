import type { KeyCompatibilityResult, KeyRelationship } from '../types/transition';
import { createLogger } from '../utils/logger';

const logger = createLogger('key-compatibility-service');

// Standard pitch classes: 0 = C, 1 = C#/Db, ..., 11 = B
const PITCH_CLASSES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const KEY_TO_CAMELOT: Record<string, string> = {
  // Major keys -> B
  C: '8B',
  'C#': '3B',
  Db: '3B',
  D: '10B',
  'D#': '5B',
  Eb: '5B',
  E: '12B',
  F: '7B',
  'F#': '2B',
  Gb: '2B',
  G: '9B',
  'G#': '4B',
  Ab: '4B',
  A: '11B',
  'A#': '6B',
  Bb: '6B',
  B: '1B',
  Cb: '1B',

  // Minor keys -> A
  Am: '8A',
  'A#m': '3A',
  Bbm: '3A',
  Bm: '10A',
  Cm: '5A',
  'C#m': '12A',
  Dbm: '12A',
  Dm: '7A',
  'D#m': '2A',
  Ebm: '2A',
  Em: '9A',
  Fm: '4A',
  'F#m': '11A',
  Gbm: '11A',
  Gm: '6A',
  'G#m': '1A',
  Abm: '1A',
};

// Reverse map: Camelot code -> Pitch class and mode
const CAMELOT_TO_KEY: Record<string, string> = {
  '8B': 'C',
  '3B': 'C#',
  '10B': 'D',
  '5B': 'D#',
  '12B': 'E',
  '7B': 'F',
  '2B': 'F#',
  '9B': 'G',
  '4B': 'G#',
  '11B': 'A',
  '6B': 'A#',
  '1B': 'B',

  '8A': 'Am',
  '3A': 'A#m',
  '10A': 'Bm',
  '5A': 'Cm',
  '12A': 'C#m',
  '7A': 'Dm',
  '2A': 'D#m',
  '9A': 'Em',
  '4A': 'Fm',
  '11A': 'F#m',
  '6A': 'Gm',
  '1A': 'G#m',
};

export class KeyCompatibilityService {
  /**
   * Normalize any key string to standard notation.
   */
  normalizeKey(rawKey: string | null | undefined): string {
    if (!rawKey) return 'Unknown';
    let cleaned = rawKey.trim();
    if (KEY_TO_CAMELOT[cleaned]) return cleaned;

    // Handle common variants like "C major", "A minor", "Dbmaj", etc.
    const isMinor = /m(in|inor)?$/i.test(cleaned) || /m$/i.test(cleaned);
    const root = cleaned.replace(/(maj|major|min|minor|m)$/i, '').trim();

    const normalizedRoot = root.charAt(0).toUpperCase() + root.slice(1);
    const candidate = isMinor ? `${normalizedRoot}m` : normalizedRoot;

    return KEY_TO_CAMELOT[candidate] ? candidate : 'Unknown';
  }

  /**
   * Convert key string to Camelot code (e.g. "Am" -> "8A", "C" -> "8B").
   */
  getCamelotCode(key: string | null | undefined): string {
    const norm = this.normalizeKey(key);
    return KEY_TO_CAMELOT[norm] || '8B';
  }

  /**
   * Parse a Camelot code into numeric hour (1-12) and mode ('A' | 'B').
   */
  parseCamelot(code: string): { hour: number; mode: 'A' | 'B' } {
    const match = code.match(/^(\d+)([AB])$/i);
    if (!match) return { hour: 8, mode: 'B' };
    let hour = parseInt(match[1], 10);
    if (hour < 1 || hour > 12) hour = 8;
    const mode = match[2].toUpperCase() as 'A' | 'B';
    return { hour, mode };
  }

  /**
   * Calculate harmonic relationship and base compatibility score between two Camelot codes.
   */
  evaluateCamelotRelationship(
    camA: string,
    camB: string,
  ): { relationship: KeyRelationship; score: number } {
    const a = this.parseCamelot(camA);
    const b = this.parseCamelot(camB);

    // Exact match
    if (a.hour === b.hour && a.mode === b.mode) {
      return { relationship: 'SAME_KEY', score: 1.0 };
    }

    // Relative Major / Minor (same hour, different mode)
    if (a.hour === b.hour && a.mode !== b.mode) {
      return { relationship: 'RELATIVE_MAJOR_MINOR', score: 0.95 };
    }

    // Circular distance on Camelot clock (1 to 12)
    const hourDiff = Math.min(Math.abs(a.hour - b.hour), 12 - Math.abs(a.hour - b.hour));

    // Adjacent Fifth (±1 hour on circle, same mode)
    if (hourDiff === 1 && a.mode === b.mode) {
      return { relationship: 'ADJACENT_FIFTH', score: 0.9 };
    }

    // Diagonal Step (±1 hour on circle, different mode)
    if (hourDiff === 1 && a.mode !== b.mode) {
      return { relationship: 'DIAGONAL', score: 0.8 };
    }

    // Energy Modulation (+2 hours clockwise or counterclockwise)
    if (hourDiff === 2 && a.mode === b.mode) {
      return { relationship: 'MODULATION', score: 0.7 };
    }

    // Incompatible without adjustment
    return { relationship: 'INCOMPATIBLE', score: Math.max(0.2, 0.6 - hourDiff * 0.1) };
  }

  /**
   * Calculate pitch class index (0-11) and mode for a key.
   */
  private getPitchClass(key: string): { pitchClass: number; isMinor: boolean } {
    const norm = this.normalizeKey(key);
    const isMinor = norm.endsWith('m');
    const root = isMinor ? norm.slice(0, -1) : norm;
    let idx = PITCH_CLASSES.indexOf(root);
    if (idx === -1) {
      // Check enharmonics
      if (root === 'Db') idx = 1;
      else if (root === 'Eb') idx = 3;
      else if (root === 'Gb') idx = 6;
      else if (root === 'Ab') idx = 8;
      else if (root === 'Bb') idx = 10;
      else if (root === 'Cb') idx = 11;
      else idx = 0;
    }
    return { pitchClass: idx, isMinor };
  }

  /**
   * Shift a key by semitones (-1 or +1) and return the resulting key string.
   */
  shiftKeyBySemitones(key: string, semitones: number): string {
    const { pitchClass, isMinor } = this.getPitchClass(key);
    const shiftedClass = (pitchClass + semitones + 12) % 12;
    const shiftedRoot = PITCH_CLASSES[shiftedClass];
    return isMinor ? `${shiftedRoot}m` : shiftedRoot;
  }

  /**
   * Evaluate full key compatibility with micro pitch shift recommendations.
   *
   * @param outgoingKey - Outgoing track key
   * @param incomingKey - Incoming track key
   * @param incomingConfidence - Key detection confidence of incoming track (0 to 1)
   * @param allowPitchShift - Whether pitch shifting is enabled / supported by FFmpeg
   */
  evaluate(
    outgoingKey: string | null | undefined,
    incomingKey: string | null | undefined,
    incomingConfidence = 0.8,
    allowPitchShift = true,
  ): KeyCompatibilityResult {
    const normOut = this.normalizeKey(outgoingKey);
    const normIn = this.normalizeKey(incomingKey);

    const camOut = this.getCamelotCode(normOut);
    const camIn = this.getCamelotCode(normIn);

    const baseEval = this.evaluateCamelotRelationship(camOut, camIn);

    // If already highly compatible (>= 0.85) or keys unknown, no pitch shift needed
    if (baseEval.score >= 0.85 || normOut === 'Unknown' || normIn === 'Unknown') {
      return {
        outgoingKey: normOut,
        incomingKey: normIn,
        outgoingCamelot: camOut,
        incomingCamelot: camIn,
        relationship: baseEval.relationship,
        compatibilityScore: baseEval.score,
        pitchShiftSemitones: 0,
        shiftApplied: false,
        explanation: `Naturally compatible via ${baseEval.relationship} (${camOut} → ${camIn}, score: ${baseEval.score.toFixed(2)})`,
      };
    }

    // If pitch shifting is disabled or confidence is low, return unshifted result
    if (!allowPitchShift || incomingConfidence < 0.55) {
      return {
        outgoingKey: normOut,
        incomingKey: normIn,
        outgoingCamelot: camOut,
        incomingCamelot: camIn,
        relationship: baseEval.relationship,
        compatibilityScore: baseEval.score,
        pitchShiftSemitones: 0,
        shiftApplied: false,
        explanation: `Unshifted mixing (confidence ${incomingConfidence.toFixed(2)} below threshold or pitch shift disabled): score ${baseEval.score.toFixed(2)}`,
      };
    }

    // Evaluate micro pitch shifts: +1 semitone and -1 semitone
    const shiftPlusKey = this.shiftKeyBySemitones(normIn, 1);
    const shiftPlusCam = this.getCamelotCode(shiftPlusKey);
    const evalPlus = this.evaluateCamelotRelationship(camOut, shiftPlusCam);

    const shiftMinusKey = this.shiftKeyBySemitones(normIn, -1);
    const shiftMinusCam = this.getCamelotCode(shiftMinusKey);
    const evalMinus = this.evaluateCamelotRelationship(camOut, shiftMinusCam);

    // Find best shift with a tiny 0.03 artifact penalty for applying pitch processing
    let bestShift = 0;
    let bestScore = baseEval.score;
    let bestRel = baseEval.relationship;
    let bestCam = camIn;

    if (evalPlus.score - 0.03 > bestScore && evalPlus.score >= 0.85) {
      bestScore = evalPlus.score - 0.03;
      bestShift = 1;
      bestRel = evalPlus.relationship;
      bestCam = shiftPlusCam;
    }

    if (evalMinus.score - 0.03 > bestScore && evalMinus.score >= 0.85) {
      bestScore = evalMinus.score - 0.03;
      bestShift = -1;
      bestRel = evalMinus.relationship;
      bestCam = shiftMinusCam;
    }

    if (bestShift !== 0) {
      logger.debug(
        { normOut, normIn, bestShift, fromCam: camIn, toCam: bestCam, score: bestScore },
        'Harmonic micro pitch shift recommended',
      );
      return {
        outgoingKey: normOut,
        incomingKey: normIn,
        outgoingCamelot: camOut,
        incomingCamelot: camIn,
        relationship: bestRel,
        compatibilityScore: bestScore,
        pitchShiftSemitones: bestShift,
        shiftApplied: true,
        explanation: `Micro pitch shift (${bestShift > 0 ? '+1' : '-1'} semitone) aligns ${camIn} to ${bestCam} (${bestRel}, score: ${bestScore.toFixed(2)})`,
      };
    }

    return {
      outgoingKey: normOut,
      incomingKey: normIn,
      outgoingCamelot: camOut,
      incomingCamelot: camIn,
      relationship: baseEval.relationship,
      compatibilityScore: baseEval.score,
      pitchShiftSemitones: 0,
      shiftApplied: false,
      explanation: `No micro pitch shift improves compatibility: score ${baseEval.score.toFixed(2)}`,
    };
  }
}
