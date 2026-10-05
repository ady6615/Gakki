/**
 * Deterministic Local Command Matcher
 *
 * Implements Requirement 35:
 * High-speed offline regex and pattern-matching intent parser that works
 * instantly without Gemini, providing seamless graceful fallback when
 * Gemini is offline or for zero-latency local execution.
 */

import type { VoiceIntent } from '../types/voice-command';

export class LocalCommandMatcher {
  /**
   * Matches a recognized speech transcript directly into a structured VoiceIntent.
   * Strips wake words ("hey gakki", "gakki") if present, while preserving original casing
   * for queries, song titles, and playlist names.
   */
  static match(transcript: string): VoiceIntent | null {
    if (!transcript || transcript.trim().length === 0) return null;

    let clean = transcript.trim();

    // Strip common wake words and polite prefixes preserving casing
    clean = clean.replace(/^(?:(?:hey|hi|ok|okay)\s+)?gakki[\s,:]*/i, '').trim();
    clean = clean.replace(/^(?:please|can you|could you)\s+/i, '').trim();

    if (clean.length === 0) return null;

    const lower = clean.toLowerCase();

    // 1. PLAY TRACK / SEARCH
    const playMatch = clean.match(/^(?:play|put on|start|queue|listen to)\s+(.+)$/i);
    if (playMatch) {
      const query = playMatch[1].trim();
      // Check if it's "play playlist X"
      const playlistSubMatch = query.match(/^playlist\s+(.+)$/i);
      if (playlistSubMatch) {
        return {
          intent: 'PLAY_PLAYLIST',
          playlistName: playlistSubMatch[1].trim(),
          confidence: 0.95,
          rawTranscript: transcript,
          isConversational: false,
        };
      }
      return {
        intent: 'PLAY_TRACK',
        query,
        confidence: 0.95,
        rawTranscript: transcript,
        isConversational: false,
      };
    }

    // Direct "playlist <name>" match
    const plDirectMatch = clean.match(/^(?:playlist|open playlist|load playlist)\s+(.+)$/i);
    if (plDirectMatch) {
      return {
        intent: 'PLAY_PLAYLIST',
        playlistName: plDirectMatch[1].trim(),
        confidence: 0.95,
        rawTranscript: transcript,
        isConversational: false,
      };
    }

    // 2. PAUSE
    if (lower.match(/^(?:pause|hold on|freeze)(?:\s+(?:the\s+)?(?:music|song|track))?$/i)) {
      return {
        intent: 'PAUSE',
        confidence: 0.98,
        rawTranscript: transcript,
        isConversational: false,
      };
    }

    // 3. RESUME
    if (lower.match(/^(?:resume|unpause|continue|play)(?:\s+(?:the\s+)?(?:music|song|track))?$/i)) {
      return {
        intent: 'RESUME',
        confidence: 0.98,
        rawTranscript: transcript,
        isConversational: false,
      };
    }

    // 4. SKIP / NEXT
    if (lower.match(/^(?:skip|next|next\s+song|next\s+track|skip\s+song|skip\s+track)$/i)) {
      return {
        intent: 'SKIP',
        confidence: 0.98,
        rawTranscript: transcript,
        isConversational: false,
      };
    }

    // 5. STOP
    if (lower.match(/^(?:stop|stop\s+playing|stop\s+the\s+music|shut\s+up|clear)$/i)) {
      return {
        intent: 'STOP',
        confidence: 0.98,
        rawTranscript: transcript,
        isConversational: false,
      };
    }

    // 6. VOLUME (SET_VOLUME)
    const volMatch = lower.match(/^(?:set\s+)?volume\s+(?:to\s+)?(\d{1,3})(?:%)?$/i);
    if (volMatch) {
      const vol = Math.min(100, Math.max(0, parseInt(volMatch[1], 10)));
      return {
        intent: 'SET_VOLUME',
        volume: vol,
        confidence: 0.95,
        rawTranscript: transcript,
        isConversational: false,
      };
    }

    if (lower.match(/^(?:volume\s+up|turn\s+it\s+up|louder)$/i)) {
      return {
        intent: 'SET_VOLUME',
        volume: 80,
        confidence: 0.9,
        rawTranscript: transcript,
        isConversational: false,
      };
    }

    if (lower.match(/^(?:volume\s+down|turn\s+it\s+down|softer|quieter)$/i)) {
      return {
        intent: 'SET_VOLUME',
        volume: 30,
        confidence: 0.9,
        rawTranscript: transcript,
        isConversational: false,
      };
    }

    // 7. SMART SHUFFLE / SHUFFLE
    if (lower.match(/^(?:smart\s+shuffle|ai\s+shuffle|intelligent\s+shuffle)$/i)) {
      return {
        intent: 'SMART_SHUFFLE',
        confidence: 0.98,
        rawTranscript: transcript,
        isConversational: false,
      };
    }
    if (lower.match(/^(?:shuffle|mix\s+up\s+queue)$/i)) {
      return {
        intent: 'SHUFFLE',
        confidence: 0.95,
        rawTranscript: transcript,
        isConversational: false,
      };
    }

    // 8. ENABLE / DISABLE DJ
    if (lower.match(/^(?:enable\s+dj|turn\s+on\s+dj|start\s+dj|dj\s+on)$/i)) {
      return {
        intent: 'ENABLE_DJ',
        confidence: 0.98,
        rawTranscript: transcript,
        isConversational: false,
      };
    }
    if (lower.match(/^(?:disable\s+dj|turn\s+off\s+dj|stop\s+dj|dj\s+off)$/i)) {
      return {
        intent: 'DISABLE_DJ',
        confidence: 0.98,
        rawTranscript: transcript,
        isConversational: false,
      };
    }

    // 9. SHOW LYRICS
    if (lower.match(/^(?:show\s+lyrics|lyrics|what\s+are\s+the\s+lyrics|display\s+lyrics)$/i)) {
      return {
        intent: 'SHOW_LYRICS',
        confidence: 0.95,
        rawTranscript: transcript,
        isConversational: false,
      };
    }

    // 10. SAVE FAVORITE
    if (lower.match(/^(?:save\s+(?:to\s+)?favorites?|favorite(?:\s+this\s+song)?|like\s+this\s+song|heart)$/i)) {
      return {
        intent: 'SAVE_FAVORITE',
        confidence: 0.95,
        rawTranscript: transcript,
        isConversational: false,
      };
    }

    // 11. SET LOOP
    if (lower.match(/^(?:loop\s+track|repeat\s+song|repeat\s+track|loop\s+song)$/i)) {
      return {
        intent: 'SET_LOOP',
        loopMode: 'track',
        confidence: 0.95,
        rawTranscript: transcript,
        isConversational: false,
      };
    }
    if (lower.match(/^(?:loop\s+queue|repeat\s+queue|loop\s+all)$/i)) {
      return {
        intent: 'SET_LOOP',
        loopMode: 'queue',
        confidence: 0.95,
        rawTranscript: transcript,
        isConversational: false,
      };
    }
    if (lower.match(/^(?:loop\s+off|stop\s+looping|repeat\s+off)$/i)) {
      return {
        intent: 'SET_LOOP',
        loopMode: 'off',
        confidence: 0.95,
        rawTranscript: transcript,
        isConversational: false,
      };
    }

    // 12. CONVERSATIONAL QUERIES
    if (lower.match(/^(?:what\s+should\s+i\s+play|recommend|what\s+song\s+is\s+this|who\s+sings\s+this|tell\s+me\s+about\s+this\s+song)/i)) {
      return {
        intent: 'CONVERSATIONAL_QUERY',
        query: clean,
        confidence: 0.9,
        rawTranscript: transcript,
        isConversational: true,
      };
    }

    return null;
  }
}
