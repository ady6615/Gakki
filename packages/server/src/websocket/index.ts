import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import type { AudioPlayerManager, VoicePlatformState } from '@gakki/core';
import { createLogger } from '@gakki/core';

const logger = createLogger('websocket');

let wssInstance: WebSocketServer | null = null;
let lastKnownState: VoicePlatformState = {
  guildId: null,
  voiceState: 'DISCONNECTED',
  playerState: 'IDLE',
  track: null,
};

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
        logger.error({ err }, 'Failed to send WebSocket message to client');
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
  playerManager?: AudioPlayerManager,
): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  wssInstance = wss;

  wss.on('connection', (ws) => {
    logger.info('WebSocket client connected');

    ws.on('close', () => {
      logger.debug('WebSocket client disconnected');
    });

    ws.on('error', (error) => {
      logger.error({ err: error }, 'WebSocket client error');
    });

    // Send connection ack
    ws.send(
      JSON.stringify({
        type: 'connected',
        timestamp: new Date().toISOString(),
      }),
    );

    // Send current playback state immediately
    const stateToSend: VoicePlatformState =
      playerManager && playerManager.getAllStates().length > 0
        ? playerManager.getAllStates()[0]
        : lastKnownState;

    ws.send(
      JSON.stringify({
        type: 'playback_state',
        payload: stateToSend,
        timestamp: new Date().toISOString(),
      }),
    );
  });

  // If playerManager is passed, listen to state changes and broadcast
  if (playerManager) {
    playerManager.onStateChange((state) => {
      broadcastPlaybackState(state);
    });
  }

  logger.info('WebSocket server attached at /ws');
  return wss;
}
