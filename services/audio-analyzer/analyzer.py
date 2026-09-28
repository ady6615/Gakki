"""
Gakki Music Platform — Audio Analysis Service
Modular audio feature extraction using librosa, numpy, and scipy.
"""

import os
import sys
import json
import hashlib
import traceback
import numpy as np
import librosa

FEATURE_VERSION = 1
EMBEDDING_VERSION = 1
MAX_AUDIO_DURATION_SECONDS = 1200  # 20 minutes max limit
MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024  # 100 MB max limit

# Krumhansl-Schmuckler Key Profiles for Key Estimation
PITCH_CLASSES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

# Normalize profiles
MAJOR_PROFILE = (MAJOR_PROFILE - np.mean(MAJOR_PROFILE)) / (np.std(MAJOR_PROFILE) + 1e-8)
MINOR_PROFILE = (MINOR_PROFILE - np.mean(MINOR_PROFILE)) / (np.std(MINOR_PROFILE) + 1e-8)


def compute_content_hash(file_path: str) -> str:
    """Compute SHA-256 hash of file content for idempotent feature caching."""
    hasher = hashlib.sha256()
    with open(file_path, 'rb') as f:
        while chunk := f.read(65536):
            hasher.update(chunk)
    return hasher.hexdigest()


def estimate_musical_key(chroma_mean: np.ndarray) -> str:
    """Estimate musical key (e.g. 'C', 'Am') using Krumhansl-Schmuckler correlation."""
    if chroma_mean.shape[0] != 12:
        return 'Unknown'
    
    # Standardize chroma mean
    norm_chroma = (chroma_mean - np.mean(chroma_mean)) / (np.std(chroma_mean) + 1e-8)

    best_corr = -1.0
    best_key = 'Unknown'

    for i in range(12):
        # Rotate profiles
        rotated_major = np.roll(MAJOR_PROFILE, i)
        rotated_minor = np.roll(MINOR_PROFILE, i)

        corr_major = float(np.dot(norm_chroma, rotated_major) / 12.0)
        corr_minor = float(np.dot(norm_chroma, rotated_minor) / 12.0)

        if corr_major > best_corr:
            best_corr = corr_major
            best_key = PITCH_CLASSES[i]

        if corr_minor > best_corr:
            best_corr = corr_minor
            best_key = f"{PITCH_CLASSES[i]}m"

    return best_key


def generate_normalized_embedding(features: dict) -> list[float]:
    """
    Construct a compact, normalized 32-dimensional acoustic embedding vector.
    
    Dimensions (total 32):
    - [0]: Normalized tempo (clamped bpm / 200)
    - [1]: Normalized acoustic energy [0, 1]
    - [2]: Spectral centroid / 8000
    - [3]: Spectral bandwidth / 4000
    - [4]: Spectral contrast / 40
    - [5]: Spectral rolloff / 8000
    - [6]: Spectral flatness [0, 1]
    - [7]: Zero crossing rate / 0.3
    - [8..19]: 12 pitch chroma class profile (L1 normalized)
    - [20..29]: First 10 MFCC coefficients (standardized and bounded)
    - [30]: Harmonic-to-percussive ratio (sigmoid mapped)
    - [31]: Tempo confidence [0, 1]
    """
    vec = np.zeros(32, dtype=np.float32)

    # 0: Tempo
    bpm = features.get('bpm', 120.0) or 120.0
    vec[0] = np.clip(bpm / 200.0, 0.0, 1.5)

    # 1: Energy
    vec[1] = np.clip(features.get('energy', 0.5) or 0.5, 0.0, 1.0)

    # 2..6: Spectral
    vec[2] = np.clip((features.get('spectralCentroid', 2000.0) or 2000.0) / 8000.0, 0.0, 1.5)
    vec[3] = np.clip((features.get('spectralBandwidth', 2000.0) or 2000.0) / 4000.0, 0.0, 1.5)
    vec[4] = np.clip((features.get('spectralContrast', 20.0) or 20.0) / 40.0, 0.0, 1.5)
    vec[5] = np.clip((features.get('spectralRolloff', 4000.0) or 4000.0) / 8000.0, 0.0, 1.5)
    vec[6] = np.clip(features.get('spectralFlatness', 0.05) or 0.05, 0.0, 1.0)

    # 7: Zero crossing rate
    vec[7] = np.clip((features.get('zeroCrossingRate', 0.05) or 0.05) / 0.3, 0.0, 1.5)

    # 8..19: Chroma (12)
    chroma = features.get('chroma', []) or []
    if len(chroma) == 12:
        c_arr = np.array(chroma, dtype=np.float32)
        c_sum = np.sum(c_arr)
        if c_sum > 1e-6:
            c_arr = c_arr / c_sum
        vec[8:20] = c_arr
    else:
        vec[8:20] = 1.0 / 12.0

    # 20..29: MFCC (first 10)
    mfcc = features.get('mfcc', []) or []
    for i in range(10):
        if i < len(mfcc):
            # Typical MFCC ranges: -100 to 100
            val = float(mfcc[i])
            if i == 0:
                val_norm = np.clip((val + 200.0) / 400.0, 0.0, 1.0)
            else:
                val_norm = np.clip((val + 50.0) / 100.0, 0.0, 1.0)
            vec[20 + i] = val_norm
        else:
            vec[20 + i] = 0.5

    # 30: Harmonic ratio
    rhythm = features.get('rhythmFeatures', {}) or {}
    hpr = rhythm.get('harmonicPercussiveRatio', 1.0) or 1.0
    vec[30] = np.clip(float(1.0 / (1.0 + np.exp(-np.log(max(hpr, 1e-4))))), 0.0, 1.0)

    # 31: Tempo confidence
    vec[31] = np.clip(features.get('tempoConfidence', 0.5) or 0.5, 0.0, 1.0)

    # L2 normalize the entire 32-dim vector for cosine distance
    norm = np.linalg.norm(vec)
    if norm > 1e-6:
        vec = vec / norm

    return [float(x) for x in vec]


def analyze_audio_file(file_path: str, content_hash: str = None) -> dict:
    """
    Run full acoustic analysis on an audio file.
    
    Safe execution:
    - Never throws an uncaught exception
    - Handles missing files, corrupt audio, silence, very short/long audio
    - Returns structured result dict with analysis_status: 'READY' or 'FAILED'
    """
    if not os.path.exists(file_path):
        return {
            'analysisStatus': 'FAILED',
            'errorMessage': f'Audio file does not exist: {file_path}',
            'featureVersion': FEATURE_VERSION,
            'embeddingVersion': EMBEDDING_VERSION,
        }

    # Verify file size
    file_size = os.path.getsize(file_path)
    if file_size > MAX_FILE_SIZE_BYTES:
        return {
            'analysisStatus': 'FAILED',
            'errorMessage': f'Audio file exceeds maximum size limit ({file_size} > {MAX_FILE_SIZE_BYTES} bytes)',
            'featureVersion': FEATURE_VERSION,
            'embeddingVersion': EMBEDDING_VERSION,
        }

    if not content_hash:
        try:
            content_hash = compute_content_hash(file_path)
        except Exception as e:
            content_hash = 'unknown'

    try:
        # Load audio (mono, 22050 Hz, capped duration)
        y, sr = librosa.load(file_path, sr=22050, mono=True, duration=MAX_AUDIO_DURATION_SECONDS)
        duration_sec = float(librosa.get_duration(y=y, sr=sr))

        if len(y) == 0:
            return {
                'analysisStatus': 'FAILED',
                'errorMessage': 'Audio file decoded into 0 samples',
                'featureVersion': FEATURE_VERSION,
                'embeddingVersion': EMBEDDING_VERSION,
                'contentHash': content_hash,
            }

        # Check silence
        peak_amp = float(np.max(np.abs(y)))
        if peak_amp < 1e-4:
            # Silent track fallback
            default_chroma = [1.0 / 12.0] * 12
            default_mfcc = [0.0] * 13
            result = {
                'analysisStatus': 'READY',
                'contentHash': content_hash,
                'featureVersion': FEATURE_VERSION,
                'embeddingVersion': EMBEDDING_VERSION,
                'duration': duration_sec,
                'bpm': 100.0,
                'tempoConfidence': 0.1,
                'energy': 0.0,
                'key': 'C',
                'spectralCentroid': 0.0,
                'spectralBandwidth': 0.0,
                'spectralContrast': 0.0,
                'spectralRolloff': 0.0,
                'spectralFlatness': 0.0,
                'zeroCrossingRate': 0.0,
                'chroma': default_chroma,
                'mfcc': default_mfcc,
                'rhythmFeatures': {
                    'onsetStrengthMean': 0.0,
                    'beatRegularity': 0.0,
                    'harmonicPercussiveRatio': 1.0,
                },
                'embedding': [0.0] * 32,
            }
            result['embedding'] = generate_normalized_embedding(result)
            return result

        # 1. Tempo & Beats
        onset_env = librosa.onset.onset_strength(y=y, sr=sr)
        tempo, beats = librosa.beat.beat_track(onset_envelope=onset_env, sr=sr)
        bpm = float(tempo[0]) if hasattr(tempo, '__len__') else float(tempo)
        # Normalize BPM to positive realistic range [40, 240]
        if bpm <= 0 or np.isnan(bpm):
            bpm = 120.0
            tempo_confidence = 0.2
        else:
            # Calculate tempo confidence from onset autocorrelation peak
            ac = librosa.autocorrelate(onset_env, max_size=2 * sr // 512)
            if len(ac) > 1 and np.max(ac) > 0:
                tempo_confidence = float(np.clip(np.std(ac) / (np.mean(ac) + 1e-6), 0.1, 1.0))
            else:
                tempo_confidence = 0.5

        # 2. Acoustic Energy (RMS)
        rms = librosa.feature.rms(y=y)
        mean_rms = float(np.mean(rms))
        # Compressed mapping: 0.2 RMS ~ 1.0 energy
        energy = float(np.clip(mean_rms * 4.5, 0.0, 1.0))

        # 3. Spectral Descriptors
        sc = librosa.feature.spectral_centroid(y=y, sr=sr)
        sb = librosa.feature.spectral_bandwidth(y=y, sr=sr)
        s_contrast = librosa.feature.spectral_contrast(y=y, sr=sr)
        s_rolloff = librosa.feature.spectral_rolloff(y=y, sr=sr)
        s_flatness = librosa.feature.spectral_flatness(y=y)
        zcr = librosa.feature.zero_crossing_rate(y=y)

        spectral_centroid = float(np.mean(sc))
        spectral_bandwidth = float(np.mean(sb))
        spectral_contrast = float(np.mean(s_contrast))
        spectral_rolloff = float(np.mean(s_rolloff))
        spectral_flatness = float(np.mean(s_flatness))
        zero_crossing_rate = float(np.mean(zcr))

        # 4. Chroma & Key Estimation
        chroma = librosa.feature.chroma_stft(y=y, sr=sr)
        chroma_mean = np.mean(chroma, axis=1)
        estimated_key = estimate_musical_key(chroma_mean)
        chroma_list = [float(x) for x in chroma_mean]

        # 5. MFCCs (13 coefficients)
        mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13)
        mfcc_mean = [float(x) for x in np.mean(mfcc, axis=1)]

        # 6. Harmonic & Percussive Components (HPSS)
        y_harm, y_perc = librosa.effects.hpss(y)
        harm_rms = float(np.mean(librosa.feature.rms(y=y_harm)))
        perc_rms = float(np.mean(librosa.feature.rms(y=y_perc)))
        hp_ratio = float(harm_rms / (perc_rms + 1e-6))

        # 7. Rhythm Descriptors
        onset_mean = float(np.mean(onset_env))
        beat_regularity = float(np.clip(1.0 - (np.std(np.diff(beats)) / (np.mean(np.diff(beats)) + 1e-6)) if len(beats) > 2 else 0.5, 0.0, 1.0))

        rhythm_features = {
            'onsetStrengthMean': onset_mean,
            'beatRegularity': beat_regularity,
            'harmonicRms': harm_rms,
            'percussiveRms': perc_rms,
            'harmonicPercussiveRatio': hp_ratio,
            'beatCount': len(beats),
        }

        feature_dict = {
            'analysisStatus': 'READY',
            'contentHash': content_hash,
            'featureVersion': FEATURE_VERSION,
            'embeddingVersion': EMBEDDING_VERSION,
            'duration': duration_sec,
            'bpm': round(bpm, 2),
            'tempoConfidence': round(tempo_confidence, 3),
            'energy': round(energy, 4),
            'key': estimated_key,
            'spectralCentroid': round(spectral_centroid, 2),
            'spectralBandwidth': round(spectral_bandwidth, 2),
            'spectralContrast': round(spectral_contrast, 2),
            'spectralRolloff': round(spectral_rolloff, 2),
            'spectralFlatness': round(spectral_flatness, 5),
            'zeroCrossingRate': round(zero_crossing_rate, 5),
            'chroma': chroma_list,
            'mfcc': mfcc_mean,
            'rhythmFeatures': rhythm_features,
        }

        # 8. Normalized Embedding
        embedding = generate_normalized_embedding(feature_dict)
        feature_dict['embedding'] = embedding

        return feature_dict

    except Exception as e:
        trace = traceback.format_exc()
        return {
            'analysisStatus': 'FAILED',
            'errorMessage': f'{str(e)}',
            'traceback': trace,
            'featureVersion': FEATURE_VERSION,
            'embeddingVersion': EMBEDDING_VERSION,
            'contentHash': content_hash,
        }


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'Usage: python analyzer.py <file_path> [content_hash]'}))
        sys.exit(1)

    target_file = sys.argv[1]
    hash_arg = sys.argv[2] if len(sys.argv) > 2 else None
    result = analyze_audio_file(target_file, hash_arg)
    print(json.dumps(result))
