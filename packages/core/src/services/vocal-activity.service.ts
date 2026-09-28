/**
 * Phase 9: Vocal Activity Detection & Cue Extraction Service
 *
 * Implements requirement 12 & 13:
 * - Normalized vocal activity envelope v(t) in [0, 1]
 * - Short-time energy / spectral analysis with smoothing and hysteresis
 * - Vocal cue detection (vocalStart, vocalEnd, vocalIntensity, vocalConfidence)
 * - Instrumental cue detection (instrumentalOutroStart, outroEnd, intensity)
 */

import type {
  TrackVocalFeatures,
  VocalActivityPoint,
  VocalCues,
  InstrumentalCues,
} from '../types/stem';
import { createLogger } from '../utils/logger';

const logger = createLogger('vocal-activity-service');

export interface VocalEnvelopeOptions {
  windowSizeSec?: number; // e.g. 0.2s
  hopSizeSec?: number; // e.g. 0.1s
  activationThreshold?: number; // Hysteresis ON threshold (default 0.15)
  deactivationThreshold?: number; // Hysteresis OFF threshold (default 0.08)
  smoothingWindow?: number; // Moving average window size in points (default 5)
}

export class VocalActivityService {
  private readonly defaultOptions: Required<VocalEnvelopeOptions> = {
    windowSizeSec: 0.2,
    hopSizeSec: 0.1,
    activationThreshold: 0.15,
    deactivationThreshold: 0.08,
    smoothingWindow: 5,
  };

  /**
   * Smooth raw energy points and apply hysteresis thresholding to prevent fluttering
   */
  public processActivityEnvelope(
    rawPoints: VocalActivityPoint[],
    options?: VocalEnvelopeOptions,
  ): VocalActivityPoint[] {
    const opts = { ...this.defaultOptions, ...options };
    if (!rawPoints || rawPoints.length === 0) return [];

    // 1. Moving average smoothing
    const smoothed: VocalActivityPoint[] = [];
    const halfWin = Math.floor(opts.smoothingWindow / 2);

    for (let i = 0; i < rawPoints.length; i++) {
      let sum = 0;
      let count = 0;
      for (let j = Math.max(0, i - halfWin); j <= Math.min(rawPoints.length - 1, i + halfWin); j++) {
        sum += rawPoints[j].v;
        count++;
      }
      smoothed.push({
        t: Math.round(rawPoints[i].t * 100) / 100,
        v: count > 0 ? sum / count : rawPoints[i].v,
      });
    }

    // 2. Hysteresis stabilization
    let isActive = false;
    const finalPoints: VocalActivityPoint[] = [];

    for (const pt of smoothed) {
      if (!isActive && pt.v >= opts.activationThreshold) {
        isActive = true;
      } else if (isActive && pt.v <= opts.deactivationThreshold) {
        isActive = false;
      }

      // If active, keep full smoothed value (clamped [0, 1]); if inactive, attenuate floor noise
      const attenuatedV = isActive ? Math.min(1.0, Math.max(0.0, pt.v)) : Math.max(0.0, pt.v * 0.2);
      finalPoints.push({
        t: pt.t,
        v: Math.round(attenuatedV * 1000) / 1000,
      });
    }

    return finalPoints;
  }

  /**
   * Extract vocal cues (start, end, intensity, confidence) from processed envelope
   */
  public extractVocalCues(
    envelope: VocalActivityPoint[],
    durationSeconds: number,
  ): VocalCues {
    if (!envelope || envelope.length === 0) {
      return {
        vocalStartSeconds: null,
        vocalEndSeconds: null,
        vocalIntensity: 0.0,
        confidence: 0.0,
      };
    }

    const activeThreshold = 0.2;
    let vocalStart: number | null = null;
    let vocalEnd: number | null = null;
    let activeSum = 0;
    let activeCount = 0;

    for (const pt of envelope) {
      if (pt.v >= activeThreshold) {
        if (vocalStart === null) {
          vocalStart = pt.t;
        }
        vocalEnd = pt.t;
        activeSum += pt.v;
        activeCount++;
      }
    }

    const vocalIntensity = activeCount > 0 ? Math.round((activeSum / activeCount) * 100) / 100 : 0.0;
    const coverage = durationSeconds > 0 ? (activeCount * 0.1) / durationSeconds : 0;
    const confidence = activeCount > 5 ? Math.min(0.95, Math.max(0.5, 0.6 + coverage * 0.3)) : 0.4;

    return {
      vocalStartSeconds: vocalStart !== null ? Math.round(vocalStart * 10) / 10 : null,
      vocalEndSeconds: vocalEnd !== null ? Math.round(vocalEnd * 10) / 10 : null,
      vocalIntensity,
      confidence: Math.round(confidence * 100) / 100,
    };
  }

  /**
   * Extract candidate instrumental outro cues (regions where vocals are low and track is wrapping up)
   */
  public extractInstrumentalCues(
    envelope: VocalActivityPoint[],
    durationSeconds: number,
  ): InstrumentalCues {
    if (!envelope || envelope.length === 0 || durationSeconds <= 0) {
      return {
        outroStartSeconds: null,
        outroEndSeconds: null,
        instrumentalIntensity: 0.8,
        confidence: 0.5,
      };
    }

    // Inspect final 30% or last 40 seconds of track
    const outroWindowStart = Math.max(0, durationSeconds - Math.min(40, durationSeconds * 0.35));
    const outroPoints = envelope.filter((p) => p.t >= outroWindowStart);

    let outroStart: number | null = null;
    const lowVocalThreshold = 0.12;

    for (let i = 0; i < outroPoints.length; i++) {
      const remainingPoints = outroPoints.slice(i);
      const isCleanOutro = remainingPoints.every((p) => p.v <= lowVocalThreshold);
      if (isCleanOutro) {
        outroStart = outroPoints[i].t;
        break;
      }
    }

    const confidence = outroStart !== null ? 0.85 : 0.6;
    return {
      outroStartSeconds: outroStart !== null ? Math.round(outroStart * 10) / 10 : outroWindowStart,
      outroEndSeconds: Math.round(durationSeconds * 10) / 10,
      instrumentalIntensity: 0.75,
      confidence,
    };
  }

  /**
   * Lookup vocal activity at a specific timestamp via linear interpolation
   */
  public getVocalActivityAt(features: TrackVocalFeatures, timestampSeconds: number): number {
    const envelope = features.vocalEnvelope;
    if (!envelope || envelope.length === 0) {
      return features.meanVocalActivity ?? 0.0;
    }

    if (timestampSeconds <= envelope[0].t) {
      return envelope[0].v;
    }
    if (timestampSeconds >= envelope[envelope.length - 1].t) {
      return envelope[envelope.length - 1].v;
    }

    // Binary search for nearest points
    let low = 0;
    let high = envelope.length - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (envelope[mid].t === timestampSeconds) {
        return envelope[mid].v;
      }
      if (envelope[mid].t < timestampSeconds) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    const p0 = envelope[high];
    const p1 = envelope[low];
    if (!p0 || !p1) return envelope[0]?.v ?? 0.0;

    const tFrac = (timestampSeconds - p0.t) / (p1.t - p0.t);
    return Math.max(0.0, Math.min(1.0, p0.v + tFrac * (p1.v - p0.v)));
  }

  /**
   * Construct TrackVocalFeatures entity from raw points and track metadata
   */
  public buildFeatures(
    trackId: string,
    rawPoints: VocalActivityPoint[],
    durationSeconds: number,
  ): TrackVocalFeatures {
    const processedEnvelope = this.processActivityEnvelope(rawPoints);
    const vocalCues = this.extractVocalCues(processedEnvelope, durationSeconds);
    const instrumentalCues = this.extractInstrumentalCues(processedEnvelope, durationSeconds);

    const sum = processedEnvelope.reduce((acc, p) => acc + p.v, 0);
    const meanVocalActivity =
      processedEnvelope.length > 0 ? Math.round((sum / processedEnvelope.length) * 1000) / 1000 : 0.0;

    return {
      trackId,
      featureVersion: 1,
      meanVocalActivity,
      vocalEnvelope: processedEnvelope,
      vocalCues,
      instrumentalCues,
      analysisStatus: 'READY',
      errorMessage: null,
    };
  }
}
