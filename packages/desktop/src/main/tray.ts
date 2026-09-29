import { Tray, Menu, nativeImage, type BrowserWindow, app } from 'electron';
import { desktopLogger } from './logger.js';

// Clean musical note icon 16x16 PNG embedded as base64 fallback
const DEFAULT_ICON_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAA9SURBVDhPY2AYBfQFDEDAQAfB6P/oGGYA0wwM/4H4P7pmihgDDP8ZGBj/k8XQ/YxqBvAwAIYd6H6gYSAAAAadDPWq5E7PAAAAAElFTkSuQmCC',
  'base64',
);

export interface TrayCallbacks {
  onPlayPause: () => void;
  onNext: () => void;
  onToggleWindow: () => void;
  onQuit: () => void;
}

/**
 * System Tray Controller.
 * Implements Requirement 22.
 */
export class DesktopTrayManager {
  private tray: Tray | null = null;
  private currentTrackTitle: string = 'Gakki Music Platform';
  private currentArtist: string = 'Ready';
  private isPlaying: boolean = false;

  constructor(
    private readonly mainWindow: BrowserWindow,
    private readonly callbacks: TrayCallbacks,
  ) {
    this.createTray();
  }

  private createTray(): void {
    const icon = nativeImage.createFromBuffer(DEFAULT_ICON_PNG);
    this.tray = new Tray(icon);
    this.tray.setToolTip('Gakki Music Platform');

    this.tray.on('click', () => {
      this.callbacks.onToggleWindow();
    });

    this.updateContextMenu();
  }

  public updateNowPlaying(title?: string, artist?: string, isPlaying?: boolean): void {
    if (title) this.currentTrackTitle = title;
    if (artist !== undefined) this.currentArtist = artist || '';
    if (isPlaying !== undefined) this.isPlaying = isPlaying;

    if (this.tray) {
      this.tray.setToolTip(`Gakki: ${this.currentTrackTitle} - ${this.currentArtist}`);
    }
    this.updateContextMenu();
  }

  public updateContextMenu(): void {
    if (!this.tray) return;

    const contextMenu = Menu.buildFromTemplate([
      {
        label: `🎵 ${this.currentTrackTitle}`,
        enabled: false,
      },
      {
        label: `   ${this.currentArtist || 'Idle'}`,
        enabled: false,
      },
      { type: 'separator' },
      {
        label: this.isPlaying ? '❚❚ Pause' : '▶ Play',
        click: () => this.callbacks.onPlayPause(),
      },
      {
        label: '⏭ Next',
        click: () => this.callbacks.onNext(),
      },
      { type: 'separator' },
      {
        label: this.mainWindow.isVisible() ? 'Hide Gakki' : 'Open Gakki',
        click: () => this.callbacks.onToggleWindow(),
      },
      {
        label: 'Quit',
        click: () => this.callbacks.onQuit(),
      },
    ]);

    this.tray.setContextMenu(contextMenu);
  }

  public destroy(): void {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}
