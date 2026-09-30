import type { Logger } from 'pino';

export type IdleTimerReason = 'empty_channel' | 'queue_empty';

export interface VoiceLifecycleCallbacks {
  onAutoLeave: (guildId: string, reason: IdleTimerReason) => Promise<void> | void;
  onLifecycleUpdate?: (
    guildId: string,
    info: {
      humanCount: number;
      timerActive: boolean;
      reason: IdleTimerReason | null;
      stayInChannel: boolean;
    },
  ) => void;
}

export interface GuildVoiceLifecycleState {
  guildId: string;
  humanCount: number;
  timer: NodeJS.Timeout | null;
  timerReason: IdleTimerReason | null;
  timerStartedAt: number | null;
  timeoutSeconds: number;
  stayInChannel: boolean;
  isBotConnected: boolean;
}

/**
 * Dedicated Voice Lifecycle Manager.
 *
 * Responsibilities:
 * - Detects whether human users remain in the bot's voice channel
 * - Detects when the playback queue becomes empty
 * - Starts, updates, and cancels inactivity / idle timers
 * - Prevents duplicate or overlapping timers
 * - Handles users joining or leaving while a timer is active
 * - Supports explicit stay-in-channel mode
 * - Triggers clean disconnects upon timeout expiration
 */
export class VoiceLifecycleManager {
  private readonly states = new Map<string, GuildVoiceLifecycleState>();
  private readonly defaultTimeoutSeconds: number;

  constructor(
    private readonly logger: Logger,
    private readonly callbacks: VoiceLifecycleCallbacks,
    defaultTimeoutSeconds: number = 300,
  ) {
    this.defaultTimeoutSeconds = Math.max(0, defaultTimeoutSeconds);
    this.logger.debug(
      { defaultTimeoutSeconds: this.defaultTimeoutSeconds },
      'VoiceLifecycleManager initialized',
    );
  }

  /**
   * Get or initialize the lifecycle state for a guild.
   */
  getOrCreateState(guildId: string): GuildVoiceLifecycleState {
    let state = this.states.get(guildId);
    if (!state) {
      state = {
        guildId,
        humanCount: 0,
        timer: null,
        timerReason: null,
        timerStartedAt: null,
        timeoutSeconds: this.defaultTimeoutSeconds,
        stayInChannel: false,
        isBotConnected: false,
      };
      this.states.set(guildId, state);
    }
    return state;
  }

  /**
   * Update bot connection status in a guild.
   */
  setBotConnected(guildId: string, connected: boolean): void {
    const state = this.getOrCreateState(guildId);
    state.isBotConnected = connected;

    if (!connected) {
      this.cancelTimer(guildId, 'bot_disconnected');
    }
    this.notifyUpdate(guildId);
  }

  /**
   * Check if bot is marked as connected in the guild.
   */
  isBotConnected(guildId: string): boolean {
    const state = this.states.get(guildId);
    return state ? state.isBotConnected : false;
  }

  /**
   * Update the human user count in the bot's voice channel.
   *
   * @param guildId - Guild identifier
   * @param count - Number of non-bot human members in the channel
   */
  handleHumanCountChange(guildId: string, count: number): void {
    const state = this.getOrCreateState(guildId);
    const oldCount = state.humanCount;
    state.humanCount = Math.max(0, count);

    this.logger.info(
      { guildId, oldCount, newCount: state.humanCount },
      '[VOICE] Human count changed: %d',
      state.humanCount,
    );

    // If stay-in-channel is active, do not start auto-leave timers
    if (state.stayInChannel) {
      this.notifyUpdate(guildId);
      return;
    }

    // Only process timers if the bot is actually connected
    if (!state.isBotConnected) {
      this.notifyUpdate(guildId);
      return;
    }

    if (state.humanCount === 0) {
      // All humans have left the voice channel
      if (!state.timer) {
        this.startTimer(guildId, 'empty_channel');
      } else if (state.timerReason === 'queue_empty') {
        // Transition existing queue timer to empty channel reason without overlapping timers
        state.timerReason = 'empty_channel';
        this.logger.debug(
          { guildId },
          '[VOICE] Transitioned idle timer reason from queue_empty to empty_channel',
        );
      }
    } else {
      // At least one human is present in the channel
      if (state.timer && state.timerReason === 'empty_channel') {
        // Human rejoined before timeout expired -> cancel timer, remain connected
        this.cancelTimer(guildId, 'human_rejoined');
      }
    }

    this.notifyUpdate(guildId);
  }

  /**
   * Handle queue becoming empty while playback finishes.
   * If humans remain and stayInChannel is false, start the queue idle timer.
   */
  handleQueueBecameEmpty(guildId: string): void {
    const state = this.getOrCreateState(guildId);

    if (state.stayInChannel) {
      this.logger.debug({ guildId }, '[VOICE] Queue empty, stayInChannel is enabled — no timer started');
      return;
    }

    if (!state.isBotConnected) {
      return;
    }

    if (state.humanCount === 0) {
      // Channel is already empty, start or maintain empty_channel timer
      if (!state.timer) {
        this.startTimer(guildId, 'empty_channel');
      }
    } else {
      // Humans are present: start queue_empty idle timer if none active
      if (!state.timer) {
        this.startTimer(guildId, 'queue_empty');
      }
    }

    this.notifyUpdate(guildId);
  }

  /**
   * Handle new track playback starting.
   * Cancels any active queue-empty idle timer, and cancels empty_channel timer if humans are present.
   */
  handleTrackStarted(guildId: string): void {
    const state = this.getOrCreateState(guildId);
    if (state.timer) {
      if (state.timerReason === 'queue_empty') {
        this.cancelTimer(guildId, 'track_started');
      } else if (state.timerReason === 'empty_channel' && state.humanCount > 0) {
        this.cancelTimer(guildId, 'track_started_with_humans');
      }
    }
  }

  /**
   * Start an inactivity timer for the given reason.
   */
  private startTimer(guildId: string, reason: IdleTimerReason): void {
    const state = this.getOrCreateState(guildId);

    // Cancel any existing timer to avoid overlapping timers
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }

    state.timerReason = reason;
    state.timerStartedAt = Date.now();

    this.logger.info(
      { guildId, reason, timeoutSeconds: state.timeoutSeconds },
      '[VOICE] Idle timer started',
    );

    const ms = state.timeoutSeconds * 1000;
    state.timer = setTimeout(async () => {
      // Abort auto-leave if conditions changed
      if (state.stayInChannel || !state.isBotConnected) {
        state.timer = null;
        state.timerReason = null;
        state.timerStartedAt = null;
        this.notifyUpdate(guildId);
        return;
      }

      // If empty_channel timer fired, but humans are now present, abort auto-leave
      if (state.timerReason === 'empty_channel' && state.humanCount > 0) {
        this.logger.info(
          { guildId, humanCount: state.humanCount },
          '[VOICE] Auto-leave aborted — humans present in voice channel',
        );
        state.timer = null;
        state.timerReason = null;
        state.timerStartedAt = null;
        this.notifyUpdate(guildId);
        return;
      }

      this.logger.info(
        { guildId, reason: state.timerReason, timeoutSeconds: state.timeoutSeconds },
        '[VOICE] Auto-leave triggered',
      );
      state.timer = null;
      state.timerReason = null;
      state.timerStartedAt = null;

      try {
        await this.callbacks.onAutoLeave(guildId, reason);
      } catch (err) {
        this.logger.error({ err, guildId }, 'Error in onAutoLeave callback');
      }
      this.notifyUpdate(guildId);
    }, ms);

    this.notifyUpdate(guildId);
  }

  /**
   * Cancel any active idle timer for a guild.
   */
  cancelTimer(guildId: string, reason?: string): boolean {
    const state = this.states.get(guildId);
    if (!state || !state.timer) {
      return false;
    }

    clearTimeout(state.timer);
    state.timer = null;
    const oldReason = state.timerReason;
    state.timerReason = null;
    state.timerStartedAt = null;

    this.logger.info(
      { guildId, priorReason: oldReason, cancellationReason: reason || 'manual' },
      '[VOICE] Idle timer canceled',
    );
    this.notifyUpdate(guildId);
    return true;
  }

  /**
   * Check if an idle timer is currently running for a guild.
   */
  isTimerActive(guildId: string): boolean {
    const state = this.states.get(guildId);
    return Boolean(state?.timer);
  }

  /**
   * Get active timer reason.
   */
  getTimerReason(guildId: string): IdleTimerReason | null {
    const state = this.states.get(guildId);
    return state ? state.timerReason : null;
  }

  /**
   * Set stay-in-channel mode.
   * When enabled, clears active timers and prevents future auto-leaves.
   */
  setStayInChannel(guildId: string, stay: boolean): void {
    const state = this.getOrCreateState(guildId);
    state.stayInChannel = stay;

    if (stay) {
      this.cancelTimer(guildId, 'stay_in_channel_enabled');
    }
    this.notifyUpdate(guildId);
  }

  /**
   * Get stay-in-channel setting for a guild.
   */
  isStayInChannel(guildId: string): boolean {
    const state = this.states.get(guildId);
    return state ? state.stayInChannel : false;
  }

  /**
   * Set custom idle timeout in seconds for a guild.
   */
  setTimeoutSeconds(guildId: string, seconds: number): void {
    const state = this.getOrCreateState(guildId);
    state.timeoutSeconds = Math.max(0.01, seconds);
  }

  /**
   * Get idle timeout in seconds for a guild.
   */
  getTimeoutSeconds(guildId: string): number {
    const state = this.states.get(guildId);
    return state ? state.timeoutSeconds : this.defaultTimeoutSeconds;
  }

  /**
   * Get human count in the voice channel for a guild.
   */
  getHumanCount(guildId: string): number {
    const state = this.states.get(guildId);
    return state ? state.humanCount : 0;
  }

  /**
   * Clean up all state and timers for a guild.
   */
  cleanup(guildId: string): void {
    this.cancelTimer(guildId, 'cleanup');
    this.states.delete(guildId);
  }

  private notifyUpdate(guildId: string): void {
    if (!this.callbacks.onLifecycleUpdate) return;
    const state = this.getOrCreateState(guildId);
    this.callbacks.onLifecycleUpdate(guildId, {
      humanCount: state.humanCount,
      timerActive: Boolean(state.timer),
      reason: state.timerReason,
      stayInChannel: state.stayInChannel,
    });
  }
}
