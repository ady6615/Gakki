import type { ISOTimestamp } from './common';

export interface UserFavorite {
  userId: string;
  trackId: string;
  createdAt: ISOTimestamp;
  track?: {
    id: string;
    title: string;
    artist: string | null;
    album: string | null;
    duration: number | null;
    coverArt: string | null;
  };
}

export interface UserFavoritesPage {
  items: UserFavorite[];
  total: number;
  page: number;
  limit: number;
}
