import { WebSocketServer } from 'ws';
import type { Server } from 'node:http';
import { createLogger } from '@gakki/core';

const logger = createLogger('websocket');

/**
 * Attach a WebSocket server to the existing HTTP server.
 *
 * Shares the same port as the Express API server. Clients connect
 * to ws://host:port/ws.
 *
 * Phase 1: Connection lifecycle only. Real-time queue synchronization
 * (broadcasting queue state changes to all connected web clients)
 * will be implemented alongside the queue management system.
 */
export function createWebSocketServer(httpServer: Server): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws) => {
    logger.info('WebSocket client connected');

    ws.on('close', () => {
      logger.debug('WebSocket client disconnected');
    });

    ws.on('error', (error) => {
      logger.error({ err: error }, 'WebSocket client error');
    });

    // Confirm connection with a welcome message
    ws.send(JSON.stringify({
      type: 'connected',
      timestamp: new Date().toISOString(),
    }));
  });

  logger.info('WebSocket server attached at /ws');
  return wss;
}
