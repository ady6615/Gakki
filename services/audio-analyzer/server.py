"""
Gakki Music Platform — Audio Analysis HTTP Service
Flask server providing REST endpoints for audio feature extraction.
"""

import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from flask import Flask, request, jsonify
from analyzer import analyze_audio_file, FEATURE_VERSION, EMBEDDING_VERSION, TRANSITION_FEATURE_VERSION

app = Flask(__name__)

PORT = int(os.environ.get('AUDIO_ANALYZER_PORT', 5050))
MAX_CONCURRENT_JOBS = int(os.environ.get('AUDIO_ANALYZER_CONCURRENCY', 2))
JOB_TIMEOUT_SECONDS = int(os.environ.get('AUDIO_ANALYZER_TIMEOUT', 30))

# Semaphore to strictly limit concurrency to prevent CPU starvation
semaphore = threading.Semaphore(MAX_CONCURRENT_JOBS)
executor = ThreadPoolExecutor(max_workers=MAX_CONCURRENT_JOBS)


@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        'status': 'ok',
        'service': 'gakki-audio-analyzer',
        'version': '1.0.0',
        'featureVersion': FEATURE_VERSION,
        'embeddingVersion': EMBEDDING_VERSION,
        'transitionFeatureVersion': TRANSITION_FEATURE_VERSION,
        'maxConcurrency': MAX_CONCURRENT_JOBS,
        'timeoutSeconds': JOB_TIMEOUT_SECONDS,
    })


@app.route('/analyze', methods=['POST'])
def analyze():
    data = request.get_json(silent=True)
    if not data or 'filePath' not in data:
        return jsonify({
            'analysisStatus': 'FAILED',
            'errorMessage': 'Missing required JSON parameter: filePath',
            'featureVersion': FEATURE_VERSION,
            'embeddingVersion': EMBEDDING_VERSION,
        }), 400

    file_path = data['filePath']
    content_hash = data.get('contentHash')

    # Try acquiring semaphore with 2-second queue timeout
    acquired = semaphore.acquire(blocking=True, timeout=5.0)
    if not acquired:
        return jsonify({
            'analysisStatus': 'FAILED',
            'errorMessage': 'Server busy: maximum audio analysis concurrency reached',
            'featureVersion': FEATURE_VERSION,
            'embeddingVersion': EMBEDDING_VERSION,
        }), 503

    try:
        future = executor.submit(analyze_audio_file, file_path, content_hash)
        result = future.result(timeout=JOB_TIMEOUT_SECONDS)
        status_code = 200 if result.get('analysisStatus') == 'READY' else 422
        return jsonify(result), status_code
    except TimeoutError:
        return jsonify({
            'analysisStatus': 'FAILED',
            'errorMessage': f'Audio analysis timed out after {JOB_TIMEOUT_SECONDS}s',
            'featureVersion': FEATURE_VERSION,
            'embeddingVersion': EMBEDDING_VERSION,
        }), 504
    except Exception as e:
        return jsonify({
            'analysisStatus': 'FAILED',
            'errorMessage': str(e),
            'featureVersion': FEATURE_VERSION,
            'embeddingVersion': EMBEDDING_VERSION,
        }), 500
    finally:
        semaphore.release()


if __name__ == '__main__':
    print(f"[AUDIO-ANALYZER] Starting server on port {PORT} (concurrency={MAX_CONCURRENT_JOBS}, timeout={JOB_TIMEOUT_SECONDS}s)...")
    app.run(host='127.0.0.1', port=PORT, threaded=True)
