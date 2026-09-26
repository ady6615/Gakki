import type { Logger } from 'pino';
import { randomUUID } from 'node:crypto';
import type { GuildQueue, QueueTrack, QueueDisplayItem } from '../types/queue';

type QueueChangeListener = (guildId: string, queue: GuildQueue) => void;

/**
 * In-memory FIFO queue manager isolated per Discord guild.
 *
 * This manager has ZERO direct coupling to Discord classes, voice connections,
 * or AudioPlayer instances. It only manages queue state, ordering,
 * enqueue/dequeue, and removal operations.
 */
export class QueueManager {
  private readonly queues = new Map<string, GuildQueue>();
  private readonly changeListeners = new Set<QueueChangeListener>();

  constructor(private readonly logger: Logger) {
    this.logger.debug('QueueManager initialized');
  }

  /**
   * Subscribe to queue change events across all guilds.
   */
  onQueueChange(listener: QueueChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  private notifyChange(guildId: string): void {
    const queue = this.getOrCreateQueue(guildId);
    for (const listener of this.changeListeners) {
      try {
        listener(guildId, queue);
      } catch (err) {
        this.logger.error({ err, guildId }, 'Error in queue change listener');
      }
    }
  }

  /**
   * Get or initialize the in-memory queue for a guild.
   */
  getOrCreateQueue(guildId: string): GuildQueue {
    let queue = this.queues.get(guildId);
    if (!queue) {
      queue = {
        guildId,
        tracks: [],
      };
      this.queues.set(guildId, queue);
    }
    return queue;
  }

  /**
   * Add a single track to the end of the guild's queue.
   */
  addTrack(
    guildId: string,
    trackInput: Omit<QueueTrack, 'id'> & { id?: string },
  ): QueueTrack {
    const queue = this.getOrCreateQueue(guildId);
    const track: QueueTrack = {
      id: trackInput.id || randomUUID(),
      name: trackInput.name,
      path: trackInput.path,
      duration: trackInput.duration,
      addedBy: trackInput.addedBy,
      artist: trackInput.artist,
      album: trackInput.album,
      thumbnailUrl: trackInput.thumbnailUrl,
      sourceProvider: trackInput.sourceProvider,
      sourceUrl: trackInput.sourceUrl,
      source: trackInput.source,
      artwork: trackInput.artwork,
    };

    queue.tracks.push(track);
    this.logger.info(
      { guildId, trackId: track.id, name: track.name, position: queue.tracks.length },
      '[QUEUE] Added track: %s',
      track.name,
    );
    this.notifyChange(guildId);
    return track;
  }

  /**
   * Add multiple tracks to the end of the guild's queue in the given order.
   */
  addTracks(
    guildId: string,
    trackInputs: Array<Omit<QueueTrack, 'id'> & { id?: string }>,
  ): QueueTrack[] {
    const queue = this.getOrCreateQueue(guildId);
    const added: QueueTrack[] = [];

    for (const input of trackInputs) {
      const track: QueueTrack = {
        id: input.id || randomUUID(),
        name: input.name,
        path: input.path,
        duration: input.duration,
        addedBy: input.addedBy,
        artist: input.artist,
        album: input.album,
        thumbnailUrl: input.thumbnailUrl,
        sourceProvider: input.sourceProvider,
        sourceUrl: input.sourceUrl,
        source: input.source,
        artwork: input.artwork,
      };
      queue.tracks.push(track);
      added.push(track);
      this.logger.info(
        { guildId, trackId: track.id, name: track.name, position: queue.tracks.length },
        '[QUEUE] Added track: %s',
        track.name,
      );
    }

    if (added.length > 0) {
      this.notifyChange(guildId);
    }
    return added;
  }

  /**
   * Dequeue and return the next track in FIFO order, or null if the queue is empty.
   */
  getNext(guildId: string): QueueTrack | null {
    const queue = this.queues.get(guildId);
    if (!queue || queue.tracks.length === 0) {
      return null;
    }

    const nextTrack = queue.tracks.shift()!;
    this.logger.debug(
      { guildId, trackId: nextTrack.id, name: nextTrack.name },
      '[QUEUE] Dequeued next track: %s',
      nextTrack.name,
    );
    this.notifyChange(guildId);
    return nextTrack;
  }

  /**
   * Remove a track by its unique track ID.
   */
  removeTrack(guildId: string, trackId: string): QueueTrack | null {
    const queue = this.queues.get(guildId);
    if (!queue) return null;

    const index = queue.tracks.findIndex((t) => t.id === trackId);
    if (index === -1) return null;

    const [removed] = queue.tracks.splice(index, 1);
    this.logger.info(
      { guildId, trackId: removed.id, name: removed.name },
      '[QUEUE] Removed track: %s',
      removed.name,
    );
    this.notifyChange(guildId);
    return removed;
  }

  /**
   * Remove a track by its position (0-based index or 1-based index).
   * @param isOneBased - Set to true if index is 1-based (standard for Discord users)
   */
  removeByIndex(guildId: string, index: number, isOneBased: boolean = true): QueueTrack | null {
    const queue = this.queues.get(guildId);
    if (!queue) return null;

    const targetIndex = isOneBased ? index - 1 : index;
    if (targetIndex < 0 || targetIndex >= queue.tracks.length) {
      return null;
    }

    const [removed] = queue.tracks.splice(targetIndex, 1);
    this.logger.info(
      { guildId, trackId: removed.id, name: removed.name, position: index },
      '[QUEUE] Removed track: %s at position %d',
      removed.name,
      index,
    );
    this.notifyChange(guildId);
    return removed;
  }

  /**
   * Clear all queued tracks for a guild.
   */
  clearQueue(guildId: string): void {
    const queue = this.queues.get(guildId);
    if (queue) {
      const count = queue.tracks.length;
      queue.tracks = [];
      this.logger.info({ guildId, clearedCount: count }, '[QUEUE] Queue cleared');
      this.notifyChange(guildId);
    }
  }

  /**
   * Inspect current queued tracks for a guild.
   */
  inspectQueue(guildId: string): QueueTrack[] {
    const queue = this.queues.get(guildId);
    if (!queue) return [];
    return [...queue.tracks];
  }

  /**
   * Get queue items formatted for display (with 1-based positions, without internal paths).
   */
  getDisplayQueue(guildId: string): QueueDisplayItem[] {
    const queue = this.queues.get(guildId);
    if (!queue) return [];
    return queue.tracks.map((track, i) => ({
      position: i + 1,
      id: track.id,
      name: track.name,
      duration: track.duration,
      addedBy: track.addedBy,
      artist: track.artist,
      album: track.album,
      thumbnailUrl: track.thumbnailUrl,
      sourceProvider: track.sourceProvider,
      source: track.source,
      artwork: track.artwork,
    }));
  }

  /**
   * Get total number of tracks in the guild queue.
   */
  getQueueLength(guildId: string): number {
    const queue = this.queues.get(guildId);
    return queue ? queue.tracks.length : 0;
  }

  /**
   * Check if a guild's queue is empty.
   */
  isEmpty(guildId: string): boolean {
    const queue = this.queues.get(guildId);
    return !queue || queue.tracks.length === 0;
  }

  /**
   * Perform an in-place Fisher-Yates shuffle of the queued tracks for the guild.
   * Does NOT touch the currently playing track.
   * Returns true if shuffled, false if queue has 0 or 1 tracks.
   */
  shuffle(guildId: string): boolean {
    const queue = this.queues.get(guildId);
    if (!queue || queue.tracks.length <= 1) {
      return false;
    }

    // In-place Fisher-Yates shuffle
    for (let i = queue.tracks.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [queue.tracks[i], queue.tracks[j]] = [queue.tracks[j], queue.tracks[i]];
    }

    this.logger.info(
      { guildId, trackCount: queue.tracks.length },
      '[QUEUE] Shuffled',
    );
    this.notifyChange(guildId);
    return true;
  }

  /**
   * Move a track from one position in the queue to another.
   *
   * @param fromIndex - Source position (1-based by default)
   * @param toIndex - Destination position (1-based by default)
   * @param isOneBased - Whether indexes are 1-based (default true)
   */
  moveTrack(
    guildId: string,
    fromIndex: number,
    toIndex: number,
    isOneBased: boolean = true,
  ): QueueTrack | null {
    const queue = this.queues.get(guildId);
    if (!queue) return null;

    const from = isOneBased ? fromIndex - 1 : fromIndex;
    const to = isOneBased ? toIndex - 1 : toIndex;

    if (
      from < 0 ||
      from >= queue.tracks.length ||
      to < 0 ||
      to >= queue.tracks.length ||
      from === to
    ) {
      return null;
    }

    const [track] = queue.tracks.splice(from, 1);
    queue.tracks.splice(to, 0, track);

    this.logger.info(
      {
        guildId,
        trackId: track.id,
        name: track.name,
        from: fromIndex,
        to: toIndex,
      },
      '[QUEUE] Track moved: %s from %d to %d',
      track.name,
      fromIndex,
      toIndex,
    );
    this.notifyChange(guildId);
    return track;
  }

  /**
   * Delete queue on bot leave or cleanup.
   */
  deleteQueue(guildId: string): void {
    this.queues.delete(guildId);
  }
}
