import type { Id, ISOTimestamp } from './common';
import type { Track } from './track';

/** A saved playlist */
export interface Playlist {
  id: Id;
  name: string;
  description: string | null;
  trackCount: number;
  createdAt: ISOTimestamp;
  updatedAt: ISOTimestamp;
}

/** A track within a playlist, with position */
export interface PlaylistTrack {
  track: Track;
  position: number;
  addedAt: ISOTimestamp;
}

/** Data required to create a new playlist */
export interface CreatePlaylistInput {
  name: string;
  description?: string;
}

/** Data for updating an existing playlist */
export interface UpdatePlaylistInput {
  name?: string;
  description?: string | null;
}
