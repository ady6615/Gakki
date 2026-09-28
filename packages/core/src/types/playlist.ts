import type { Id, ISOTimestamp } from './common';
import type { Track } from './track';

export type PlaylistVisibility = 'public' | 'private' | 'guild';

/** A saved playlist */
export interface Playlist {
  id: Id;
  name: string;
  description: string | null;
  ownerUserId: string | null;
  guildId: string | null;
  visibility: PlaylistVisibility;
  trackCount: number;
  createdAt: ISOTimestamp;
  updatedAt: ISOTimestamp;
  coverArt?: string | null;
  isFavorite?: boolean;
}

/** A track within a playlist, with position and persistent metadata */
export interface PlaylistTrack {
  id?: string;
  playlistId?: string;
  trackId: string;
  position: number;
  addedBy: string | null;
  addedAt: ISOTimestamp;
  track?: {
    id: string;
    title: string;
    artist: string | null;
    album: string | null;
    duration: number | null;
    coverArt: string | null;
  };
  source?: {
    provider: string;
    sourceType: string;
    sourceUrl: string;
    externalId: string | null;
  } | null;
}

/** Data required to create a new playlist */
export interface CreatePlaylistInput {
  name: string;
  description?: string;
  ownerUserId?: string;
  guildId?: string;
  visibility?: PlaylistVisibility;
  coverArt?: string;
}

/** Data for updating an existing playlist */
export interface UpdatePlaylistInput {
  name?: string;
  description?: string | null;
  visibility?: PlaylistVisibility;
  coverArt?: string | null;
  isFavorite?: boolean;
}

/** Reorder track payload */
export interface ReorderPlaylistTrackInput {
  fromPosition: number;
  toPosition: number;
}
