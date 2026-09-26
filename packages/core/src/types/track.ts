import type { Id, ISOTimestamp, Seconds, AudioSourceType } from './common';

/** Represents a single audio track in the system */
export interface Track {
  id: Id;
  title: string;
  artist: string | null;
  album: string | null;
  duration: Seconds | null;
  filePath: string | null;
  sourceType: AudioSourceType;
  sourceId: string | null;
  createdAt: ISOTimestamp;
}

/** Data required to create a new track */
export interface CreateTrackInput {
  title: string;
  artist?: string;
  album?: string;
  duration?: Seconds;
  filePath?: string;
  sourceType: AudioSourceType;
  sourceId?: string;
}

/** Data for updating an existing track */
export interface UpdateTrackInput {
  title?: string;
  artist?: string | null;
  album?: string | null;
  duration?: Seconds | null;
  filePath?: string | null;
}
