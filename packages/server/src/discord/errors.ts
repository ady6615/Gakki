/**
 * Standardized User-Facing Error UX for Gakki Discord & API.
 * Provides clean, consistent, friendly messages without raw stack traces.
 */

export class StandardBotError {
  public readonly isUserFacing = true;
  constructor(
    public readonly message: string,
    public readonly code: string = 'ERROR',
    public readonly isWarning: boolean = false
  ) {}

  toString(): string {
    const icon = this.isWarning ? '⚠️' : '❌';
    return `${icon} ${this.message}`;
  }
}

function makeCallableError(message: string, code: string, isWarning = false) {
  const instance = new StandardBotError(message, code, isWarning);
  const fn = () => instance;
  Object.setPrototypeOf(fn, StandardBotError.prototype);
  Object.assign(fn, instance);
  return fn as unknown as StandardBotError & (() => StandardBotError);
}

export const BotErrors = {
  NOT_IN_VOICE: makeCallableError('You must be in a voice channel to use this command.', 'NOT_IN_VOICE'),
  DIFFERENT_VOICE: makeCallableError('You must be in the same voice channel as the bot.', 'DIFFERENT_VOICE'),
  TRACK_NOT_RESOLVED: makeCallableError('This track could not be resolved.', 'TRACK_NOT_RESOLVED'),
  TRACK_UNAVAILABLE: makeCallableError('This track is currently unavailable.', 'TRACK_UNAVAILABLE', true),
  LYRICS_NOT_FOUND: Object.assign(
    (trackName?: string) => new StandardBotError(trackName ? `No lyrics found for "${trackName}".` : 'No lyrics found for this track.', 'LYRICS_NOT_FOUND', true),
    new StandardBotError('No lyrics found for this track.', 'LYRICS_NOT_FOUND', true)
  ),
  NOTHING_PLAYING: makeCallableError('Nothing is currently playing in this server.', 'NOTHING_PLAYING', true),
  PLAYLIST_NOT_FOUND: (name: string) => new StandardBotError(`Playlist "${name}" was not found.`, 'PLAYLIST_NOT_FOUND'),
  PLAYLIST_NO_PERMISSION: makeCallableError('You do not have permission to modify this playlist.', 'PLAYLIST_NO_PERMISSION'),
  QUEUE_EMPTY: makeCallableError('The queue is empty.', 'QUEUE_EMPTY', true),
  INSUFFICIENT_PERMISSIONS: (requiredRole: string) =>
    new StandardBotError(`You do not have permission to perform this action (requires ${requiredRole} or higher).`, 'INSUFFICIENT_PERMISSIONS'),
  INVALID_POSITION: makeCallableError('The specified position is invalid for this queue or playlist.', 'INVALID_POSITION'),
};

/**
 * Format any error safely for Discord reply without leaking internal details.
 */
export function formatUserFacingError(err: unknown): string {
  if (err instanceof StandardBotError) {
    return err.toString();
  }

  if (err instanceof Error) {
    if (err.name === 'PlaylistPermissionError') {
      return BotErrors.PLAYLIST_NO_PERMISSION.toString();
    }
    if (err.name === 'PlaylistNotFoundError') {
      return `❌ ${err.message}`;
    }
    if (err.message.includes('voice channel')) {
      return BotErrors.NOT_IN_VOICE.toString();
    }
  }

  return '❌ An unexpected error occurred while processing your request. Please try again.';
}
