import { Notification, app } from 'electron';
import { desktopLogger } from './logger.js';

export interface NotificationSettings {
  enabled: boolean;
  trackChanges: boolean;
  recordingEvents: boolean;
  playlistEvents: boolean;
}

/**
 * Native Desktop Notifications Manager.
 * Implements Requirement 20.
 */
export class DesktopNotificationManager {
  private settings: NotificationSettings = {
    enabled: true,
    trackChanges: true,
    recordingEvents: true,
    playlistEvents: true,
  };

  constructor(initialSettings?: Partial<NotificationSettings>) {
    if (initialSettings) {
      this.settings = { ...this.settings, ...initialSettings };
    }
  }

  public updateSettings(newSettings: Partial<NotificationSettings>): void {
    this.settings = { ...this.settings, ...newSettings };
  }

  public getSettings(): NotificationSettings {
    return { ...this.settings };
  }

  public notifyTrackChange(title: string, artist?: string): void {
    if (!this.settings.enabled || !this.settings.trackChanges) return;

    if (typeof Notification !== 'undefined' && typeof Notification.isSupported === 'function' && Notification.isSupported()) {
      new Notification({
        title: 'Now Playing — Gakki',
        body: artist ? `${title} • ${artist}` : title,
        silent: true,
      }).show();
    }
  }

  public notifyPlaylistStarted(playlistTitle: string, trackCount: number): void {
    if (!this.settings.enabled || !this.settings.playlistEvents) return;

    if (typeof Notification !== 'undefined' && typeof Notification.isSupported === 'function' && Notification.isSupported()) {
      new Notification({
        title: 'Playlist Started',
        body: `Playing "${playlistTitle}" (${trackCount} tracks)`,
        silent: true,
      }).show();
    }
  }

  public notifyRecordingStarted(sessionTitle: string): void {
    if (!this.settings.enabled || !this.settings.recordingEvents) return;

    desktopLogger.info('RECORDING', `Started recording session: ${sessionTitle}`);
    if (typeof Notification !== 'undefined' && typeof Notification.isSupported === 'function' && Notification.isSupported()) {
      new Notification({
        title: 'Recording Started',
        body: `Voice session "${sessionTitle}" is being recorded.`,
      }).show();
    }
  }

  public notifyRecordingCompleted(sessionTitle: string, durationFormatted: string): void {
    if (!this.settings.enabled || !this.settings.recordingEvents) return;

    desktopLogger.info('RECORDING', `Stopped recording session: ${sessionTitle} (${durationFormatted})`);
    if (typeof Notification !== 'undefined' && typeof Notification.isSupported === 'function' && Notification.isSupported()) {
      new Notification({
        title: 'Recording Completed',
        body: `"${sessionTitle}" (${durationFormatted}) saved. Transcription running.`,
      }).show();
    }
  }
}
