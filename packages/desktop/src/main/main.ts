import { app, BrowserWindow, ipcMain, shell, powerSaveBlocker } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { desktopLogger } from './logger.js';
import { DesktopTrayManager } from './tray.js';
import { DesktopShortcutManager } from './shortcuts.js';
import { DesktopNotificationManager } from './notifications.js';
import { ElectronAudioOutputCoordinator } from './audio-output/desktop-audio-output.js';
import { ElectronAudioInputCoordinator } from './audio-input/desktop-audio-input.js';

class GakkiDesktopApp {
  private mainWindow: BrowserWindow | null = null;
  private trayManager: DesktopTrayManager | null = null;
  private shortcutManager: DesktopShortcutManager | null = null;
  private notificationManager: DesktopNotificationManager;
  private audioOutputCoordinator: ElectronAudioOutputCoordinator;
  private audioInputCoordinator: ElectronAudioInputCoordinator;
  private powerSaveId: number | null = null;

  // Configurable preferences
  private minimizeToTray = true;
  private isQuitting = false;

  constructor() {
    this.notificationManager = new DesktopNotificationManager();
    this.audioOutputCoordinator = new ElectronAudioOutputCoordinator();
    this.audioInputCoordinator = new ElectronAudioInputCoordinator();
  }

  public async start(): Promise<void> {
    desktopLogger.info('DESKTOP', 'Initializing Gakki Desktop Application...');

    // Prevent background throttling of audio playback (Requirement 23)
    try {
      this.powerSaveId = powerSaveBlocker.start('prevent-app-suspension');
    } catch {
      // ignore
    }

    await app.whenReady();

    this.createMainWindow();
    this.setupTray();
    this.setupShortcuts();
    this.setupIpcHandlers();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        this.createMainWindow();
      } else if (this.mainWindow) {
        this.mainWindow.show();
      }
    });

    app.on('before-quit', () => {
      this.isQuitting = true;
      if (this.shortcutManager) {
        this.shortcutManager.unregister();
      }
      if (this.trayManager) {
        this.trayManager.destroy();
      }
      if (this.powerSaveId !== null) {
        powerSaveBlocker.stop(this.powerSaveId);
      }
    });
  }

  private createMainWindow(): void {
    const preloadPath = path.resolve(__dirname, '../preload/preload.js');

    this.mainWindow = new BrowserWindow({
      width: 1366,
      height: 860,
      minWidth: 1024,
      minHeight: 700,
      title: 'Gakki Music Platform',
      backgroundColor: '#0a0a0f',
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    // Close to tray behavior (Requirement 22 & 23)
    this.mainWindow.on('close', (event) => {
      if (!this.isQuitting && this.minimizeToTray) {
        event.preventDefault();
        this.mainWindow?.hide();
        desktopLogger.info('DESKTOP', 'Window minimized to system tray');
        return false;
      }
    });

    // Determine target URL
    const devServerUrl = process.env.VITE_DEV_SERVER_URL || process.env.DEV_URL;
    const localDistPath = path.resolve(__dirname, '../../../web/dist/index.html');

    if (devServerUrl) {
      desktopLogger.info('DESKTOP', `Loading development URL: ${devServerUrl}`);
      this.mainWindow.loadURL(devServerUrl);
    } else if (fs.existsSync(localDistPath)) {
      desktopLogger.info('DESKTOP', `Loading production bundle: ${localDistPath}`);
      this.mainWindow.loadFile(localDistPath);
    } else {
      // Fallback: try default local Vite or API port
      const fallbackUrl = 'http://localhost:3000';
      desktopLogger.info('DESKTOP', `Connecting to fallback dashboard URL: ${fallbackUrl}`);
      this.mainWindow.loadURL(fallbackUrl).catch(() => {
        // If web server not on 3000, fallback to 5173
        this.mainWindow?.loadURL('http://localhost:5173');
      });
    }

    desktopLogger.info('DESKTOP', 'Connected to Gakki UI shell');
  }

  private setupTray(): void {
    if (!this.mainWindow) return;

    this.trayManager = new DesktopTrayManager(this.mainWindow, {
      onPlayPause: () => {
        this.sendMediaControl('play-pause');
      },
      onNext: () => {
        this.sendMediaControl('next');
      },
      onToggleWindow: () => {
        if (!this.mainWindow) return;
        if (this.mainWindow.isVisible()) {
          this.mainWindow.hide();
        } else {
          this.mainWindow.show();
          this.mainWindow.focus();
        }
        this.trayManager?.updateContextMenu();
      },
      onQuit: () => {
        this.isQuitting = true;
        app.quit();
      },
    });
  }

  private setupShortcuts(): void {
    this.shortcutManager = new DesktopShortcutManager({
      onPlayPause: () => this.sendMediaControl('play-pause'),
      onNext: () => this.sendMediaControl('next'),
      onPrevious: () => this.sendMediaControl('previous'),
      onVolumeUp: () => this.sendMediaControl('volume-up'),
      onVolumeDown: () => this.sendMediaControl('volume-down'),
      onMute: () => this.sendMediaControl('mute'),
    });

    this.shortcutManager.register();
  }

  private sendMediaControl(action: string): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('media:control', action);
    }
  }

  private setupIpcHandlers(): void {
    // Window control IPCs
    ipcMain.on('window:minimize', () => {
      this.mainWindow?.minimize();
    });

    ipcMain.on('window:maximize', () => {
      if (this.mainWindow?.isMaximized()) {
        this.mainWindow?.unmaximize();
      } else {
        this.mainWindow?.maximize();
      }
    });

    ipcMain.on('window:close', () => {
      this.mainWindow?.close();
    });

    // Tray update IPC
    ipcMain.on('tray:update-now-playing', (_event, { title, artist, isPlaying }) => {
      this.trayManager?.updateNowPlaying(title, artist, isPlaying);
    });

    // Notification IPCs (Requirement 20)
    ipcMain.on('notify:track-change', (_event, { title, artist }) => {
      this.notificationManager.notifyTrackChange(title, artist);
    });

    ipcMain.on('notify:recording-started', (_event, { sessionTitle }) => {
      this.notificationManager.notifyRecordingStarted(sessionTitle);
    });

    ipcMain.on('notify:recording-completed', (_event, { sessionTitle, durationFormatted }) => {
      this.notificationManager.notifyRecordingCompleted(sessionTitle, durationFormatted);
    });

    ipcMain.on('notify:update-settings', (_event, settings) => {
      this.notificationManager.updateSettings(settings);
    });

    // Audio devices IPC (Requirements 6, 8, 10)
    ipcMain.handle('audio:get-devices', async () => {
      const outputs = await this.audioOutputCoordinator.getDevices();
      const inputs = await this.audioInputCoordinator.getDevices();
      return { ...outputs, inputs };
    });

    ipcMain.handle('audio:set-output-device', async (_event, deviceId: string) => {
      await this.audioOutputCoordinator.setOutputDevice(deviceId);
      return { success: true };
    });

    ipcMain.handle('audio:set-input-device', async (_event, deviceId: string) => {
      await this.audioInputCoordinator.setInputDevice(deviceId);
      return { success: true };
    });

    // Logs IPC (Requirement 31)
    ipcMain.on('logs:open-directory', () => {
      const logDir = desktopLogger.getLogDir();
      shell.openPath(logDir);
    });

    ipcMain.handle('logs:get-path', () => {
      return desktopLogger.getLogPath();
    });

    ipcMain.on('logs:write', (_event, { tag, message, meta }) => {
      desktopLogger.log(tag, message, meta);
    });
  }
}

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  const desktopApp = new GakkiDesktopApp();
  desktopApp.start().catch((err) => {
    desktopLogger.error('DESKTOP', `Fatal desktop startup error: ${err.message}`);
    process.exit(1);
  });
}
