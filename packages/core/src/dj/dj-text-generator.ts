/**
 * AI DJ Commentary Text Generator
 *
 * Implements Requirements 14, 15, 16:
 * - Generates concise, context-aware, energetic DJ speech scripts.
 * - Relies STRICTLY on verified acoustic metadata (BPM, energy, key, genre, title, artist).
 * - Explicitly prevents hallucination of unverified biographical/release facts.
 */

import type { DJCommentaryContext } from '../types/dj-commentary';

export class DJTextGenerator {
  /**
   * Generates a short, fact-based AI DJ commentary script from context.
   */
  static generateCommentaryText(context: DJCommentaryContext): string {
    const { trigger, fromTrack, toTrack, transitionPlan, djProfile, energyDelta } = context;

    switch (trigger) {
      case 'DJ_START': {
        const profileStr = djProfile ? ` in ${djProfile.toLowerCase()} mode` : '';
        if (toTrack) {
          return `AI DJ engaged${profileStr}. Starting things off with ${toTrack.title}${toTrack.artist ? ` by ${toTrack.artist}` : ''}.`;
        }
        return `AI DJ activated${profileStr}. Let's get the music rolling.`;
      }

      case 'PLAYLIST_START': {
        if (toTrack) {
          return `Kicking off the playlist with ${toTrack.title}${toTrack.artist ? ` by ${toTrack.artist}` : ''}.`;
        }
        return `Starting your playlist now.`;
      }

      case 'VIBE_PLAYLIST': {
        if (toTrack) {
          return `Here is a custom vibe mix, starting with ${toTrack.title}.`;
        }
        return `Dialing in the vibe mix.`;
      }

      case 'ENERGY_TRANSITION': {
        if (toTrack) {
          const delta = energyDelta ?? (toTrack.energy && fromTrack?.energy ? toTrack.energy - fromTrack.energy : 0);
          if (delta > 0.2) {
            return `Pumping the energy up next with ${toTrack.title}${toTrack.artist ? ` by ${toTrack.artist}` : ''}.`;
          } else if (delta < -0.2) {
            return `Bringing the tempo down smoothly into ${toTrack.title}.`;
          }
          return `Transitioning the vibe over to ${toTrack.title}.`;
        }
        return `Switching up the energy now.`;
      }

      case 'SPECIAL_TRANSITION': {
        if (toTrack && transitionPlan) {
          if (transitionPlan.pitchShiftSemitones !== 0) {
            return `Harmonically tuned transition coming in with ${toTrack.title}.`;
          }
          if (transitionPlan.tempoAdjustmentPercent !== 0) {
            return `Beat-matched seamless mix into ${toTrack.title}.`;
          }
          return `Seamless phrase-aligned blend into ${toTrack.title}.`;
        }
        return `Blending into the next track.`;
      }

      case 'USER_REQUEST': {
        if (toTrack) {
          return `Here is what's queued up next: ${toTrack.title}${toTrack.artist ? ` by ${toTrack.artist}` : ''}.`;
        }
        return `Here is your requested music.`;
      }

      case 'TRACK_TRANSITION':
      case 'REGULAR_INTERVAL':
      default: {
        if (!toTrack) return `Keeping the vibe flowing.`;

        // Check key harmony
        if (toTrack.camelotCode && fromTrack?.camelotCode && toTrack.camelotCode === fromTrack.camelotCode) {
          return `Staying in harmonic sync with ${toTrack.title}${toTrack.artist ? ` by ${toTrack.artist}` : ''}.`;
        }

        // Check BPM continuity
        if (toTrack.bpm && fromTrack?.bpm && Math.abs(toTrack.bpm - fromTrack.bpm) < 4) {
          return `Locking into that ${Math.round(toTrack.bpm)} BPM groove with ${toTrack.title}.`;
        }

        // Check genre or mood
        if (toTrack.genre) {
          return `Next up in ${toTrack.genre}, here is ${toTrack.title}${toTrack.artist ? ` from ${toTrack.artist}` : ''}.`;
        }

        return `Moving right along with ${toTrack.title}${toTrack.artist ? ` by ${toTrack.artist}` : ''}.`;
      }
    }
  }
}
