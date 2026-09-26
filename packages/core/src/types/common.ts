/**
 * Common types shared across the Gakki platform.
 */

/** Unique identifier type — UUIDs throughout the system */
export type Id = string;

/** Timestamp as ISO 8601 string */
export type ISOTimestamp = string;

/** Duration in seconds */
export type Seconds = number;

/** Supported audio source types */
export type AudioSourceType = 'local' | 'youtube' | 'soundcloud' | 'spotify' | 'url';

/**
 * Result wrapper for operations that can fail.
 * Preferred over throwing exceptions for expected failure cases.
 */
export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

/** Pagination request parameters */
export interface PaginationParams {
  limit: number;
  offset: number;
}

/** Paginated response envelope */
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}
