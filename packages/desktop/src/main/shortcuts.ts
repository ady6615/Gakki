import { globalShortcut } from 'electron';
import { desktopLogger } from './logger.js';

export interface ShortcutCallbacks {
  onPlayPause: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onVolumeUp: () => void;
  onVolumeDown: () => void;
  onMute: () => void;
}

/**
 * Global Keyboard Shortcuts Manager.
 * Registers OS-wide global hotkeys for background media control.
 *
 * Implements Requirement 21.
 * Platform notes:
 * - Windows / Linux: Standard Media keys (MediaPlayPause, MediaNextTrack, etc.) and Ctrl+Alt combos.
 * - macOS: Command+Alt combos (macOS media keys may require accessibility permissions).
 */
export class DesktopShortcutManager {
  private isRegistered = false;

  constructor(private readonly callbacks: ShortcutCallbacks) {}

  public register(): void {
    if (this.isRegistered) return;

    try {
      // 1. Play / Pause
      globalShortcut.register('MediaPlayPause', () => this.callbacks.onPlayPause());
      globalShortcut.register('CommandOrControl+Alt+Space', () => this.callbacks.onPlayPause());

      // 2. Next Track
      globalShortcut.register('MediaNextTrack', () => this.callbacks.onNext());
      globalShortcut.register('CommandOrControl+Alt+Right', () => this.callbacks.onNext());

      // 3. Previous Track
      globalShortcut.register('MediaPreviousTrack', () => this.callbacks.onPrevious());
      globalShortcut.register('CommandOrControl+Alt+Left', () => this.callbacks.onPrevious());

      // 4. Volume Up
      globalShortcut.register('CommandOrControl+Alt+Up', () => this.callbacks.onVolumeUp());

      // 5. Volume Down
      globalShortcut.register('CommandOrControl+Alt+Down', () => this.callbacks.onVolumeDown());

      // 6. Mute
      globalShortcut.register('CommandOrControl+Alt+M', () => this.callbacks.onMute());

      this.isRegistered = true;
      desktopLogger.info('DESKTOP', 'Global media shortcuts registered successfully');
    } catch (err: any) {
      desktopLogger.warn('DESKTOP', `Failed to register some global shortcuts: ${err.message}`);
    }
  }

  public unregister(): void {
    if (!this.isRegistered) return;
    try {
      globalShortcut.unregisterAll();
      this.isRegistered = false;
      desktopLogger.info('DESKTOP', 'Global shortcuts unregistered');
    } catch {
      // ignore
    }
  }
}
