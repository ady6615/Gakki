import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import type {
  AudioPlayerManager,
  PlaybackManager,
  VoicePlatformState,
  QueueUpdatedEvent,
  PlaybackSettingsUpdatedEvent,
  VoiceLifecycleUpdatedEvent,
} from '@gakki/core';
import { createLogger } from '@gakki/core';

const logger = createLogger('websocket');

let wssInstance: WebSocketServer | null = null;
let lastKnownState: VoicePlatformState = {
  guildId: '',
  voiceState: 'DISCONNECTED',
  playerState: 'IDLE',
  track: null,
};
const lastKnownQueues = new Map<string, QueueUpdatedEvent>();
const lastKnownSettings = new Map<string, PlaybackSettingsUpdatedEvent>();

/**
 * Broadcast playback state to all connected WebSocket clients.
 */
export function broadcastPlaybackState(state: VoicePlatformState): void {
  lastKnownState = state;
  if (!wssInstance) return;

  const message = JSON.stringify({
    type: 'playback_state',
    payload: state,
    timestamp: new Date().toISOString(),
  });

  for (const client of wssInstance.clients) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(message);
      } catch (err) {
        logger.error({ err }, 'Failed to send playback_state to WebSocket client');
      }
    }
  }
}

/**
 * Broadcast queue update event to all connected WebSocket clients.
 */
export function broadcastQueueUpdated(event: QueueUpdatedEvent): void {
  lastKnownQueues.set(event.guildId, event);
  if (!wssInstance) return;

  const message = JSON.stringify({
    type: 'queue.updated',
    ...event,
    timestamp: new Date().toISOString(),
  });

  for (const client of wssInstance.clients) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(message);
      } catch (err) {
        logger.error({ err }, 'Failed to send queue.updated to WebSocket client');
      }
    }
  }
}

/**
 * Broadcast playback or guild settings update event.
 */
export function broadcastSettingsUpdated(event: PlaybackSettingsUpdatedEvent | any): void {
  if (event.guildId) {
    lastKnownSettings.set(event.guildId, event);
  }
  if (!wssInstance) return;

  const message = JSON.stringify({
    ...event,
    timestamp: new Date().toISOString(),
  });

  for (const client of wssInstance.clients) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(message);
      } catch (err) {
        logger.error({ err }, 'Failed to send settings updated to WebSocket client');
      }
    }
  }
}

/**
 * Broadcast arbitrary domain event to all connected WebSocket clients.
 */
export function broadcastEvent(event: { type: string; [key: string]: any }): void {
  if (!wssInstance) return;

  const message = JSON.stringify({
    ...event,
    timestamp: new Date().toISOString(),
  });

  for (const client of wssInstance.clients) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(message);
      } catch (err) {
        logger.error({ err, type: event.type }, 'Failed to send event to WebSocket client');
      }
    }
  }
}

/**
 * Broadcast voice lifecycle update event (humanCount, timerActive, reason, stayInChannel).
 */
export function broadcastVoiceLifecycleUpdated(event: VoiceLifecycleUpdatedEvent): void {
  if (!wssInstance) return;

  const message = JSON.stringify({
    ...event,
    timestamp: new Date().toISOString(),
  });

  for (const client of wssInstance.clients) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(message);
      } catch (err) {
        logger.error({ err }, 'Failed to send voice.lifecycle.updated to WebSocket client');
      }
    }
  }
}

/**
 * Attach a WebSocket server to the existing HTTP server.
 *
 * Shares the same port as the Express API server. Clients connect
 * to ws://host:port/ws.
 */
export function createWebSocketServer(
  httpServer: Server,
  manager?: PlaybackManager | AudioPlayerManager,
): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  wssInstance = wss;

  const activePlaybackManager: PlaybackManager | undefined =
    manager && 'playbackManager' in manager
      ? (manager as AudioPlayerManager).playbackManager
      : (manager as PlaybackManager | undefined);

  wss.on('connection', (ws) => {
    logger.info('WebSocket client connected');

    ws.on('close', () => {
      logger.debug('WebSocket client disconnected');
    });

    ws.on('error', (error) => {
      logger.error({ err: error }, 'WebSocket client error');
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'request_state') {
          const targetGuildId = msg.guildId || '';
          const stateToSend = activePlaybackManager
            ? activePlaybackManager.getState(targetGuildId)
            : lastKnownState;
          ws.send(
            JSON.stringify({
              type: 'playback_state',
              payload: stateToSend,
              timestamp: new Date().toISOString(),
            }),
          );

          const qEvent = activePlaybackManager
            ? activePlaybackManager.getQueueEvent(targetGuildId)
            : lastKnownQueues.get(targetGuildId) || null;
          if (qEvent) {
            ws.send(
              JSON.stringify({
                type: 'queue.updated',
                ...qEvent,
                timestamp: new Date().toISOString(),
              }),
            );
          }

          if (activePlaybackManager) {
            const sState = activePlaybackManager.getGuildState(targetGuildId);
            ws.send(
              JSON.stringify({
                type: 'playback.settings.updated',
                guildId: sState.guildId,
                volume: sState.volume,
                filters: sState.filters,
                loopMode: sState.loopMode,
                stayInChannel: sState.stayInChannel,
                timestamp: new Date().toISOString(),
              }),
            );
          }
        }
      } catch {
        // Ignore unparseable client messages
      }
    });

    // 1. Connection acknowledgement
    ws.send(
      JSON.stringify({
        type: 'connected',
        timestamp: new Date().toISOString(),
      }),
    );

    // 2. Initial playback state
    const stateToSend = activePlaybackManager
      ? activePlaybackManager.getState('')
      : lastKnownState;

    ws.send(
      JSON.stringify({
        type: 'playback_state',
        payload: stateToSend,
        timestamp: new Date().toISOString(),
      }),
    );

    // 3. Initial queue state
    let initialQueueEvent: QueueUpdatedEvent | null = null;
    if (activePlaybackManager) {
      const activeGuilds = Array.from(lastKnownQueues.keys());
      if (activeGuilds.length > 0) {
        initialQueueEvent = activePlaybackManager.getQueueEvent(activeGuilds[0]);
      } else {
        initialQueueEvent = activePlaybackManager.getQueueEvent('');
      }
    }

    if (initialQueueEvent) {
      ws.send(
        JSON.stringify({
          type: 'queue.updated',
          ...initialQueueEvent,
          timestamp: new Date().toISOString(),
        }),
      );
    }

    // 4. Initial settings state
    if (activePlaybackManager) {
      const state = activePlaybackManager.getGuildState('');
      ws.send(
        JSON.stringify({
          type: 'playback.settings.updated',
          guildId: state.guildId,
          volume: state.volume,
          filters: state.filters,
          loopMode: state.loopMode,
          stayInChannel: state.stayInChannel,
          timestamp: new Date().toISOString(),
        }),
      );
    }
  });

  // Listen for playback, queue, settings, and lifecycle updates
  if (activePlaybackManager) {
    activePlaybackManager.onStateChange((state) => {
      broadcastPlaybackState(state);
    });

    activePlaybackManager.onQueueUpdate((event) => {
      broadcastQueueUpdated(event);
    });

    activePlaybackManager.onPlaybackSettingsUpdate((event) => {
      broadcastSettingsUpdated(event);
    });

    activePlaybackManager.onVoiceLifecycleUpdate((event) => {
      broadcastVoiceLifecycleUpdated(event);
    });

    activePlaybackManager.onPlaybackEvent((event) => {
      broadcastEvent(event);
    });
  }

  logger.info('WebSocket server attached at /ws');
  return wss;
}

export function broadcastPlaylistEvent(event: { type: string; [key: string]: any }): void {
  broadcastEvent(event);
}
