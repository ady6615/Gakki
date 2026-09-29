/// <reference types="vite/client" />

interface Window {
  gakkiDesktop?: {
    isDesktop: boolean;
    platform: string;
    window: {
      minimize: () => void;
      maximize: () => void;
      close: () => void;
    };
    tray: {
      updateNowPlaying: (title?: string, artist?: string, isPlaying?: boolean) => void;
    };
    notifications: {
      notifyTrackChange: (title: string, artist?: string) => void;
      notifyRecordingStarted: (sessionTitle: string) => void;
      notifyRecordingCompleted: (sessionTitle: string, durationFormatted: string) => void;
      updateSettings: (settings: any) => void;
    };
    audio: {
      getDevices: () => Promise<any>;
      setOutputDevice: (deviceId: string) => Promise<any>;
      setInputDevice: (deviceId: string) => Promise<any>;
      switchTarget: (target: string) => Promise<any>;
      setMonitoring: (enabled: boolean, monitorDeviceId?: string) => Promise<any>;
    };
    logs: {
      openLogDirectory: () => void;
      getLogPath: () => Promise<string>;
      writeLog: (tag: string, message: string, meta?: any) => void;
    };
    onMediaControl: (callback: (action: string) => void) => () => void;
  };
}
