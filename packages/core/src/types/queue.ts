import type { Id, ISOTimestamp } from './common';
import type { Track } from './track';

/** A single item in a playback queue */
export interface QueueItem {
  id: Id;
  track: Track;
  position: number;
  addedAt: ISOTimestamp;
  requestedBy: string | null;
}

/** The complete queue state for a guild/session */
export interface QueueState {
  guildId: string;
  items: QueueItem[];
  currentIndex: number;
  isPlaying: boolean;
  repeatMode: RepeatMode;
}

/** Queue repeat modes */
export type RepeatMode = 'off' | 'track' | 'queue';
