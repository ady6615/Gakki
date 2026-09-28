"""
Gakki Music Platform — Audio Analysis Service
Modular audio feature extraction using librosa, numpy, and scipy.
Includes Phase 8 Transition Analysis: EBU R128 loudness, Camelot Wheel harmonic key,
beat timestamps, phrase boundaries, intro/outro detection, and drop candidates.
"""

import os
import sys
import json
import hashlib
import traceback
import numpy as np
import librosa
from scipy import signal

FEATURE_VERSION = 1
EMBEDDING_VERSION = 1
TRANSITION_FEATURE_VERSION = 1
MAX_AUDIO_DURATION_SECONDS = 1200  # 20 minutes max limit
MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024  # 100 MB max limit

# Krumhansl-Schmuckler Key Profiles for Key Estimation
PITCH_CLASSES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

# Normalize profiles
MAJOR_PROFILE = (MAJOR_PROFILE - np.mean(MAJOR_PROFILE)) / (np.std(MAJOR_PROFILE) + 1e-8)
MINOR_PROFILE = (MINOR_PROFILE - np.mean(MINOR_PROFILE)) / (np.std(MINOR_PROFILE) + 1e-8)

# Camelot Wheel Mapping (Standard 1A-12A for minor, 1B-12B for major)
CAMELOT_MAP = {
    'C': '8B', 'Am': '8A',
    'G': '9B', 'Em': '9A',
    'D': '10B', 'Bm': '10A',
    'A': '11B', 'F#m': '11A', 'Gbm': '11A',
    'E': '12B', 'C#m': '12A', 'Dbm': '12A',
    'B': '1B', 'Cb': '1B', 'G#m': '1A', 'Abm': '1A',
    'F#': '2B', 'Gb': '2B', 'D#m': '2A', 'Ebm': '2A',
    'C#': '3B', 'Db': '3B', 'A#m': '3A', 'Bbm': '3A',
    'G#': '4B', 'Ab': '4B', 'Fm': '4A',
    'D#': '5B', 'Eb': '5B', 'Cm': '5A',
    'A#': '6B', 'Bb': '6B', 'Gm': '6A',
    'F': '7B', 'Dm': '7A',
}


def compute_content_hash(file_path: str) -> str:
    """Compute SHA-256 hash of file content for idempotent feature caching."""
    hasher = hashlib.sha256()
    with open(file_path, 'rb') as f:
        while chunk := f.read(65536):
            hasher.update(chunk)
    return hasher.hexdigest()


def estimate_key_and_camelot(chroma_mean: np.ndarray) -> tuple[str, float, str]:
    """
    Estimate musical key, key confidence, and Camelot Wheel code
    using Krumhansl-Schmuckler correlation.
    """
    if chroma_mean.shape[0] != 12:
        return 'Unknown', 0.1, '8B'

    # Standardize chroma mean
    norm_chroma = (chroma_mean - np.mean(chroma_mean)) / (np.std(chroma_mean) + 1e-8)

    correlations = []
    for i in range(12):
        # Rotate profiles
        rotated_major = np.roll(MAJOR_PROFILE, i)
        rotated_minor = np.roll(MINOR_PROFILE, i)

        corr_major = float(np.dot(norm_chroma, rotated_major) / 12.0)
        corr_minor = float(np.dot(norm_chroma, rotated_minor) / 12.0)

        correlations.append((corr_major, PITCH_CLASSES[i]))
        correlations.append((corr_minor, f"{PITCH_CLASSES[i]}m"))

    correlations.sort(key=lambda x: x[0], reverse=True)
    best_corr, best_key = correlations[0]
    second_corr, _ = correlations[1] if len(correlations) > 1 else (-1.0, '')

    # Compute key confidence [0.1, 1.0] based on separation between top two candidate correlations
    confidence = float(np.clip((best_corr - second_corr) / (max(best_corr, 0.05) + 0.1), 0.1, 1.0))
    camelot_code = CAMELOT_MAP.get(best_key, '8B')

    return best_key, confidence, camelot_code


def estimate_musical_key(chroma_mean: np.ndarray) -> str:
    """Backward-compatible helper returning just the key string."""
    key, _, _ = estimate_key_and_camelot(chroma_mean)
    return key


def compute_loudness_ebur128(y: np.ndarray, sr: int = 22050, target_lufs: float = -14.0) -> tuple[float, float, float, float]:
    """
    Compute ITU-R BS.1770-4 / EBU R128 loudness metrics:
    - Integrated Loudness (LUFS)
    - Loudness Range (LRA, in LU)
    - True Peak (dBTP)
    - Track Gain (dB) targeted at target_lufs with peak limiter protection
    """
    if len(y) == 0:
        return -70.0, 0.0, -70.0, 0.0

    peak = float(np.max(np.abs(y)))
    if peak < 1e-6:
        return -70.0, 0.0, -70.0, 0.0

    # Stage 1: High shelf filter (ITU-R BS.1770)
    f0 = 1681.974450955533
    gain = 10.0 ** (3.99984380697 / 20.0)
    w0 = 2 * np.pi * f0 / sr
    alpha = np.sin(w0) / (2 * 0.7071)
    A = np.sqrt(gain)

    b0 = A * ((A + 1) + (A - 1) * np.cos(w0) + 2 * np.sqrt(A) * alpha)
    b1 = -2 * A * ((A - 1) + (A + 1) * np.cos(w0))
    b2 = A * ((A + 1) + (A - 1) * np.cos(w0) - 2 * np.sqrt(A) * alpha)
    a0 = (A + 1) - (A - 1) * np.cos(w0) + 2 * np.sqrt(A) * alpha
    a1 = 2 * ((A - 1) - (A + 1) * np.cos(w0))
    a2 = (A + 1) - (A - 1) * np.cos(w0) - 2 * np.sqrt(A) * alpha
    b_hs = np.array([b0, b1, b2]) / a0
    a_hs = np.array([a0, a1, a2]) / a0

    # Stage 2: High pass filter (RLB)
    f_hp = 38.13547087602444
    w0_hp = 2 * np.pi * f_hp / sr
    alpha_hp = np.sin(w0_hp) / (2 * 0.5003)
    b_hp = np.array([(1 + np.cos(w0_hp)) / 2, -(1 + np.cos(w0_hp)), (1 + np.cos(w0_hp)) / 2]) / (1 + alpha_hp)
    a_hp = np.array([1 + alpha_hp, -2 * np.cos(w0_hp), 1 - alpha_hp]) / (1 + alpha_hp)

    y_k = signal.lfilter(b_hp, a_hp, signal.lfilter(b_hs, a_hs, y))

    # Gated Integrated Loudness (400ms blocks, 75% overlap, 100ms hop)
    block_len = int(0.400 * sr)
    hop_len = int(0.100 * sr)

    if len(y_k) < block_len:
        mean_sq = np.mean(y_k ** 2)
        int_lufs = float(-0.691 + 10 * np.log10(max(mean_sq, 1e-12)))
        true_peak = float(20 * np.log10(max(peak, 1e-6)))
        gain_db = float(target_lufs - int_lufs)
        return int_lufs, 0.0, true_peak, gain_db

    num_blocks = (len(y_k) - block_len) // hop_len + 1
    blocks = np.lib.stride_tricks.as_strided(
        y_k, shape=(num_blocks, block_len),
        strides=(y_k.strides[0] * hop_len, y_k.strides[0])
    )
    z_j = np.mean(blocks ** 2, axis=1)
    l_j = -0.691 + 10 * np.log10(np.maximum(z_j, 1e-12))

    # Absolute threshold: -70 LUFS
    pass_abs = l_j > -70.0
    if not np.any(pass_abs):
        return -70.0, 0.0, -70.0, 0.0

    # Relative threshold: gamma_r = mean(pass_abs) - 10 LU
    gamma_a = np.mean(z_j[pass_abs])
    gamma_r = -0.691 + 10 * np.log10(max(gamma_a, 1e-12)) - 10.0
    pass_rel = l_j >= gamma_r

    if np.any(pass_rel):
        int_lufs = float(-0.691 + 10 * np.log10(max(np.mean(z_j[pass_rel]), 1e-12)))
    else:
        int_lufs = float(-0.691 + 10 * np.log10(max(gamma_a, 1e-12)))

    # Loudness Range (LRA): short-term 3.0-second sliding blocks
    st_block = int(3.0 * sr)
    if len(y_k) >= st_block:
        st_num = (len(y_k) - st_block) // hop_len + 1
        st_blocks = np.lib.stride_tricks.as_strided(
            y_k, shape=(st_num, st_block),
            strides=(y_k.strides[0] * hop_len, y_k.strides[0])
        )
        st_z = np.mean(st_blocks ** 2, axis=1)
        st_l = -0.691 + 10 * np.log10(np.maximum(st_z, 1e-12))
        st_pass = (st_l > -70.0) & (st_l >= (int_lufs - 20.0))
        if len(st_pass) > 0 and np.any(st_pass):
            lra = float(np.percentile(st_l[st_pass], 95) - np.percentile(st_l[st_pass], 10))
        else:
            lra = 0.0
    else:
        lra = 0.0

    true_peak = float(20 * np.log10(max(peak, 1e-6)))
    raw_gain = target_lufs - int_lufs
    # Protect against true peak clipping above -0.5 dBTP
    track_gain = float(min(raw_gain, -0.5 - true_peak))

    return int_lufs, lra, true_peak, track_gain


def extract_transition_features(
    y: np.ndarray,
    sr: int,
    duration_sec: float,
    beats: np.ndarray,
    tempo_confidence: float,
    key: str,
    key_confidence: float,
    camelot_code: str,
) -> dict:
    """Extract transition-oriented features for Phase 8 DJ mixing."""
    int_lufs, lra, true_peak, track_gain = compute_loudness_ebur128(y, sr)

    # Beat Grid timestamps in seconds
    if len(beats) > 0:
        beat_times = [round(float(t), 3) for t in librosa.frames_to_time(beats, sr=sr)]
    else:
        beat_times = []

    # Phrase boundaries at 4, 8, 16, 32 beats
    four_beats = [round(float(beat_times[i]), 3) for i in range(0, len(beat_times), 4)]
    eight_beats = [round(float(beat_times[i]), 3) for i in range(0, len(beat_times), 8)]
    sixteen_beats = [round(float(beat_times[i]), 3) for i in range(0, len(beat_times), 16)]
    thirty_two_beats = [round(float(beat_times[i]), 3) for i in range(0, len(beat_times), 32)]

    phrase_boundaries = {
        'fourBeats': four_beats,
        'eightBeats': eight_beats,
        'sixteenBeats': sixteen_beats,
        'thirtyTwoBeats': thirty_two_beats,
    }

    # Intro & Outro detection using 100ms frame RMS
    hop_len = int(0.100 * sr)
    frame_len = int(0.400 * sr)
    if len(y) >= frame_len:
        num_frames = (len(y) - frame_len) // hop_len + 1
        rms_frames = [
            np.sqrt(np.mean(y[i * hop_len : i * hop_len + frame_len] ** 2))
            for i in range(num_frames)
        ]
        rms_arr = np.array(rms_frames)
        mean_rms = float(np.mean(rms_arr)) + 1e-6
        times = np.array([i * 0.1 for i in range(num_frames)])

        intro_thresh = 0.40 * mean_rms
        active_indices = np.where(rms_arr >= intro_thresh)[0]
        if len(active_indices) > 0:
            intro_end_time = float(times[active_indices[0]])
            intro_end = min(intro_end_time, duration_sec * 0.3)
            outro_start_time = float(times[active_indices[-1]])
            outro_start = max(outro_start_time, duration_sec * 0.7)
        else:
            intro_end = min(8.0, duration_sec * 0.2)
            outro_start = max(0.0, duration_sec - 8.0)

        intro_mask = times <= intro_end
        outro_mask = times >= outro_start
        intro_energy = float(np.mean(rms_arr[intro_mask]) / mean_rms) if np.any(intro_mask) else 0.5
        outro_energy = float(np.mean(rms_arr[outro_mask]) / mean_rms) if np.any(outro_mask) else 0.5
    else:
        intro_end = min(4.0, duration_sec * 0.2)
        outro_start = max(0.0, duration_sec - 4.0)
        intro_energy = 0.5
        outro_energy = 0.5

    # Drop candidates
    drop_candidates = []
    if len(y) > sr * 10:
        onset_env = librosa.onset.onset_strength(y=y, sr=sr)
        peaks = librosa.util.peak_pick(onset_env, pre_max=7, post_max=7, pre_avg=7, post_avg=7, delta=1.5, wait=20)
        peak_times = librosa.frames_to_time(peaks, sr=sr)
        drop_candidates = [
            round(float(t), 3) for t in peak_times
            if duration_sec * 0.2 <= t <= duration_sec * 0.8
        ][:5]

    structure_confidence = float(np.clip(
        0.4 * tempo_confidence + 0.3 * key_confidence + (0.3 if len(beat_times) > 8 else 0.1),
        0.1, 1.0
    ))

    return {
        'integratedLoudnessLufs': round(int_lufs, 2),
        'loudnessRangeLu': round(lra, 2),
        'truePeakDbtp': round(true_peak, 2),
        'trackGainDb': round(track_gain, 2),
        'beatGrid': beat_times,
        'beatConfidence': round(tempo_confidence, 3),
        'phraseBoundaries': phrase_boundaries,
        'introStart': 0.0,
        'introEnd': round(intro_end, 3),
        'introEnergy': round(intro_energy, 3),
        'outroStart': round(outro_start, 3),
        'outroEnd': round(duration_sec, 3),
        'outroEnergy': round(outro_energy, 3),
        'dropCandidates': drop_candidates,
        'key': key,
        'keyConfidence': round(key_confidence, 3),
        'camelotCode': camelot_code,
        'structureConfidence': round(structure_confidence, 3),
    }


def generate_normalized_embedding(features: dict) -> list[float]:
    """
    Construct a compact, normalized 32-dimensional acoustic embedding vector.
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
    - Includes Phase 8 transitionFeatures
    """
    if not os.path.exists(file_path):
        return {
            'analysisStatus': 'FAILED',
            'errorMessage': f'Audio file does not exist: {file_path}',
            'featureVersion': FEATURE_VERSION,
            'embeddingVersion': EMBEDDING_VERSION,
            'transitionFeatureVersion': TRANSITION_FEATURE_VERSION,
        }

    # Verify file size
    file_size = os.path.getsize(file_path)
    if file_size > MAX_FILE_SIZE_BYTES:
        return {
            'analysisStatus': 'FAILED',
            'errorMessage': f'Audio file exceeds maximum size limit ({file_size} > {MAX_FILE_SIZE_BYTES} bytes)',
            'featureVersion': FEATURE_VERSION,
            'embeddingVersion': EMBEDDING_VERSION,
            'transitionFeatureVersion': TRANSITION_FEATURE_VERSION,
        }

    if not content_hash:
        try:
            content_hash = compute_content_hash(file_path)
        except Exception:
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
                'transitionFeatureVersion': TRANSITION_FEATURE_VERSION,
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
                'transitionFeatureVersion': TRANSITION_FEATURE_VERSION,
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
                'transitionFeatures': {
                    'integratedLoudnessLufs': -70.0,
                    'loudnessRangeLu': 0.0,
                    'truePeakDbtp': -70.0,
                    'trackGainDb': 0.0,
                    'beatGrid': [],
                    'beatConfidence': 0.0,
                    'phraseBoundaries': {'fourBeats': [], 'eightBeats': [], 'sixteenBeats': [], 'thirtyTwoBeats': []},
                    'introStart': 0.0,
                    'introEnd': 0.0,
                    'introEnergy': 0.0,
                    'outroStart': 0.0,
                    'outroEnd': 0.0,
                    'outroEnergy': 0.0,
                    'dropCandidates': [],
                    'key': 'C',
                    'keyConfidence': 0.1,
                    'camelotCode': '8B',
                    'structureConfidence': 0.0,
                },
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

        # 4. Chroma & Key Estimation (with Camelot & Key Confidence)
        chroma = librosa.feature.chroma_stft(y=y, sr=sr)
        chroma_mean = np.mean(chroma, axis=1)
        estimated_key, key_confidence, camelot_code = estimate_key_and_camelot(chroma_mean)
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
        beat_regularity = float(
            np.clip(1.0 - (np.std(np.diff(beats)) / (np.mean(np.diff(beats)) + 1e-6)) if len(beats) > 2 else 0.5, 0.0, 1.0)
        )

        rhythm_features = {
            'onsetStrengthMean': onset_mean,
            'beatRegularity': beat_regularity,
            'harmonicRms': harm_rms,
            'percussiveRms': perc_rms,
            'harmonicPercussiveRatio': hp_ratio,
            'beatCount': len(beats),
        }

        # 8. Phase 8 Transition Features
        transition_features = extract_transition_features(
            y=y,
            sr=sr,
            duration_sec=duration_sec,
            beats=beats,
            tempo_confidence=tempo_confidence,
            key=estimated_key,
            key_confidence=key_confidence,
            camelot_code=camelot_code,
        )

        feature_dict = {
            'analysisStatus': 'READY',
            'contentHash': content_hash,
            'featureVersion': FEATURE_VERSION,
            'embeddingVersion': EMBEDDING_VERSION,
            'transitionFeatureVersion': TRANSITION_FEATURE_VERSION,
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
            'transitionFeatures': transition_features,
        }

        # 9. Normalized Embedding
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
            'transitionFeatureVersion': TRANSITION_FEATURE_VERSION,
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
