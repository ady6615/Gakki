import { contextBridge, ipcRenderer } from 'electron';

/**
 * Gakki Desktop Preload Bridge.
 * Securely bridges the Electron main process with the React renderer process.
 * Enforces strict isolation: no Node internals or backend credentials exposed.
 */
contextBridge.exposeInMainWorld('gakkiDesktop', {
  isDesktop: true,
  platform: process.platform,

  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
  },

  tray: {
    updateNowPlaying: (title?: string, artist?: string, isPlaying?: boolean) => {
      ipcRenderer.send('tray:update-now-playing', { title, artist, isPlaying });
    },
  },

  notifications: {
    notifyTrackChange: (title: string, artist?: string) => {
      ipcRenderer.send('notify:track-change', { title, artist });
    },
    notifyRecordingStarted: (sessionTitle: string) => {
      ipcRenderer.send('notify:recording-started', { sessionTitle });
    },
    notifyRecordingCompleted: (sessionTitle: string, durationFormatted: string) => {
      ipcRenderer.send('notify:recording-completed', { sessionTitle, durationFormatted });
    },
    updateSettings: (settings: any) => {
      ipcRenderer.send('notify:update-settings', settings);
    },
  },

  audio: {
    getDevices: () => ipcRenderer.invoke('audio:get-devices'),
    setOutputDevice: (deviceId: string) => ipcRenderer.invoke('audio:set-output-device', deviceId),
    setInputDevice: (deviceId: string) => ipcRenderer.invoke('audio:set-input-device', deviceId),
    switchTarget: (target: string) => ipcRenderer.invoke('audio:switch-target', target),
    setMonitoring: (enabled: boolean, monitorDeviceId?: string) =>
      ipcRenderer.invoke('audio:set-monitoring', { enabled, monitorDeviceId }),
  },

  logs: {
    openLogDirectory: () => ipcRenderer.send('logs:open-directory'),
    getLogPath: () => ipcRenderer.invoke('logs:get-path'),
    writeLog: (tag: string, message: string, meta?: any) => {
      ipcRenderer.send('logs:write', { tag, message, meta });
    },
  },

  onMediaControl: (callback: (action: string) => void) => {
    const listener = (_event: any, action: string) => callback(action);
    ipcRenderer.on('media:control', listener);
    return () => {
      ipcRenderer.removeListener('media:control', listener);
    };
  },
});
