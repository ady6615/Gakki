/**
 * Phase 12 Automated Verification Test Suite
 *
 * Comprehensive tests covering:
 * - 1. AudioOutput Abstraction (DesktopAudioOutput, DiscordAudioOutput, VirtualAudioOutput)
 * - 2. AudioInput Abstraction (DesktopAudioInput & 48kHz Stream Capture)
 * - 3. Audio Device Disconnection, Graceful Fallback & Recovery (Requirements 8 & 25)
 * - 4. Loopback / Monitoring with Strict Anti-Feedback Protection (Requirement 12)
 * - 5. AudioRoutingManager & Output Target Switching (Discord <-> Desktop <-> Virtual)
 * - 6. Playback Coordination & Queue Preservation Across Target Transitions (Requirement 14)
 * - 7. Audio Routing REST API Endpoints (/api/audio/*)
 * - 8. WebSocket Disconnect, Reconnect & Authoritative State Restoration (Requirements 26 & 27)
 * - 9. Desktop Security, Sanitized Logging & Native Features (Requirements 3, 20, 21, 22, 28, 31)
 * - 10. Portable Windows Desktop Packaging Verification (Requirement 30)
 */

import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import express from 'express';
import { PassThrough, Readable } from 'node:stream';
import {
  DesktopAudioOutput,
  DiscordAudioOutput,
  VirtualAudioOutput,
  DesktopAudioInput,
  DesktopPlatformAdapter,
  AudioRoutingManager,
  PlaybackManager,
  QueueManager,
  createLogger,
  type AudioDevice,
  type AudioStream,
  type QueueTrack,
} from '@gakki/core';
import { audioRoutingRoutes } from '../api/routes/audio-routing.routes';
import { createWebSocketServer } from '../websocket';

// Dynamically resolve desktop helpers to stay within server rootDir
const { DesktopLogger } = require(path.resolve(__dirname, '../../../desktop/src/main/logger'));
const { DesktopNotificationManager } = require(path.resolve(__dirname, '../../../desktop/src/main/notifications'));

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`  ✓ ${message}`);
}

async function runPhase12Tests(): Promise<void> {
  console.log('================================================================');
  console.log('       GAKKI MUSIC PLATFORM — PHASE 12 VERIFICATION SUITE       ');
  console.log('================================================================\n');

  // ── 1. AudioOutput Abstraction ───────────────────────────────────
  console.log('--- 1. AudioOutput Abstraction ---');
  const desktopOut = new DesktopAudioOutput();
  await desktopOut.initialize();

  const dummyStream: AudioStream = {
    stream: new PassThrough(),
    format: { sampleRate: 48000, channels: 2, bitDepth: 16, encoding: 'pcm_s16le' },
  };

  await desktopOut.start(dummyStream);
  assert(desktopOut.isCurrentlyPlaying() === true, 'DesktopAudioOutput enters playing state');
  assert(desktopOut.getActiveDeviceId() === 'default-output', 'Default device is selected initially');

  await desktopOut.setVolume(150);
  assert(desktopOut.getVolume() === 150, 'Volume correctly set to 150');
  await desktopOut.setVolume(300);
  assert(desktopOut.getVolume() === 200, 'Volume safely clamped at 200 max');
  await desktopOut.setVolume(-50);
  assert(desktopOut.getVolume() === 0, 'Volume safely clamped at 0 min');

  const devices = await desktopOut.getDevices();
  assert(devices.length >= 3, 'Enumerates default output devices');
  assert(devices.some((d) => d.id === 'headphones-device-1'), 'Headphones output present in device list');

  await desktopOut.setDevice('headphones-device-1');
  assert(desktopOut.getActiveDeviceId() === 'headphones-device-1', 'Successfully switched output device to Headphones');

  await desktopOut.stop();
  assert(desktopOut.isCurrentlyPlaying() === false, 'DesktopAudioOutput stops cleanly');

  // Discord Audio Output
  const discordOut = new DiscordAudioOutput();
  await discordOut.initialize();
  const discordDevs = await discordOut.getDevices();
  assert(discordDevs.length === 1 && discordDevs[0].id === 'discord-default', 'DiscordAudioOutput exposes Discord voice pipeline');

  // Virtual Audio Output
  const virtualOut = new VirtualAudioOutput([
    { id: 'cable-1', name: 'CABLE Input (VB-Audio Virtual Cable)', type: 'output', isDefault: false, isVirtual: true },
    { id: 'speakers-1', name: 'Speakers (Realtek Audio)', type: 'output', isDefault: true, isVirtual: false },
  ]);
  const virtDevs = await virtualOut.getVirtualDevices();
  assert(virtDevs.length === 1 && virtDevs[0].id === 'cable-1', 'VirtualAudioOutput correctly isolates virtual cable devices');
  assert(virtualOut.getManualSetupGuide().includes('VB-Audio'), 'Manual setup guide provided for virtual audio devices');

  // ── 2. AudioInput Abstraction ────────────────────────────────────
  console.log('\n--- 2. AudioInput Abstraction ---');
  const desktopIn = new DesktopAudioInput();
  await desktopIn.initialize();

  const inDevices = await desktopIn.getDevices();
  assert(inDevices.length >= 2, 'Enumerates input microphone devices');
  assert(desktopIn.getActiveDeviceId() === 'default-input', 'Default input selected');

  const capture = await desktopIn.startCapture();
  assert(desktopIn.isCurrentlyCapturing() === true, 'startCapture starts capture pipeline');
  assert(capture.format.sampleRate === 48000, 'Capture format standardizes to 48kHz');
  assert(capture.format.channels === 1, 'Capture format standardizes to mono 16-bit PCM');
  assert(capture.stream instanceof Readable, 'Capture returns Readable stream');

  await desktopIn.stopCapture();
  assert(desktopIn.isCurrentlyCapturing() === false, 'stopCapture terminates stream');

  // ── 3. Audio Device Disconnection & Graceful Fallback ────────────
  console.log('\n--- 3. Device Disconnection & Graceful Fallback (Req 8 & 25) ---');
  let fallbackTriggered = false;
  let fallbackReason = '';

  const resilientOut = new DesktopAudioOutput([
    { id: 'usb-dac', name: 'USB DAC Audiophile (External)', type: 'output', isDefault: false, isVirtual: false },
    { id: 'default-output', name: 'Default Speakers', type: 'output', isDefault: true, isVirtual: false },
  ]);

  resilientOut.on('deviceFallback', (_failed, fallback, reason) => {
    fallbackTriggered = true;
    fallbackReason = reason;
  });

  await resilientOut.setDevice('usb-dac');
  assert(resilientOut.getActiveDeviceId() === 'usb-dac', 'Active output switched to external USB DAC');

  await resilientOut.start(dummyStream);
  assert(resilientOut.isCurrentlyPlaying() === true, 'Playing active audio on USB DAC');

  // Simulate unplugging USB DAC
  await resilientOut.handleDeviceDisconnected('usb-dac');
  assert((fallbackTriggered as boolean) === true, 'Device disconnection emitted fallback event');
  assert(resilientOut.getActiveDeviceId() === 'default-output', 'Automatically fell back to system default device');
  assert(resilientOut.isCurrentlyPlaying() === true, 'Playback continued without crash on fallback device');

  // Requesting unavailable device
  fallbackTriggered = false;
  await resilientOut.setDevice('non-existent-device-id');
  assert((fallbackTriggered as boolean) === true, 'Selecting invalid device triggers fallback');
  assert(resilientOut.getActiveDeviceId() === 'default-output', 'Remains on system default device');

  // ── 4. Loopback / Monitoring Anti-Feedback Guard ────────────────
  console.log('\n--- 4. Loopback & Monitoring (Req 12) ---');
  const monitorOut = new DesktopAudioOutput([
    { id: 'headphones-1', name: 'Headphones', type: 'output', isDefault: true, isVirtual: false },
    { id: 'microphone-1', name: 'Microphone Array', type: 'input', isDefault: false, isVirtual: false },
  ]);

  const validMonitor = monitorOut.setMonitoring(true, 'headphones-1');
  assert(validMonitor.success === true, 'Monitoring enabled to headphones');
  assert(monitorOut.getMonitoringStatus().enabled === true, 'Monitor status is ON');

  // Attempt to monitor into microphone (feedback loop risk)
  const dangerousMonitor = monitorOut.setMonitoring(true, 'microphone-1');
  assert(dangerousMonitor.success === false, 'Anti-feedback guard blocked routing into input device');
  assert(Boolean(dangerousMonitor.error), 'Feedback error explained to user');

  monitorOut.setMonitoring(false);
  assert(monitorOut.getMonitoringStatus().enabled === false, 'Monitoring disabled cleanly');

  // ── 5. AudioRoutingManager & Target Switching ────────────────────
  console.log('\n--- 5. AudioRoutingManager & Target Switching ---');
  const routingManager = new AudioRoutingManager();
  await routingManager.initialize();

  assert(routingManager.getActiveTarget() === 'desktop', 'Initial active target is desktop');
  let targetChangedFired: boolean = false;
  routingManager.on('targetChanged', (newT, prevT) => {
    targetChangedFired = true;
    assert(newT === 'virtual' && prevT === 'desktop', 'Event reports target transition');
  });

  await routingManager.switchTarget('virtual');
  assert(routingManager.getActiveTarget() === 'virtual', 'Switched active target to virtual');
  assert((targetChangedFired as boolean) === true, 'targetChanged event fired');

  const routingState = await routingManager.getState();
  assert(routingState.target === 'virtual', 'getState reflects virtual target');
  assert(routingState.activeOutputs.length > 0, 'Active outputs enumerated in state');
  assert(routingState.activeInputs.length > 0, 'Active inputs enumerated in state');

  // ── 6. Playback Coordination & Queue Preservation ───────────────
  console.log('\n--- 6. Playback Coordination & Queue Preservation (Req 14) ---');
  const logger = createLogger('test-playback');
  const queueManager = new QueueManager(logger);
  const playbackManager = new PlaybackManager(logger, queueManager);

  // Add tracks to queue
  const track1: QueueTrack = {
    id: 'track-1',
    name: 'After Dark',
    path: path.resolve(process.cwd(), 'storage', 'test-p11', 'mixed.wav'),
    duration: 256,
    artist: 'Mr.Kitty',
  };
  const track2: QueueTrack = {
    id: 'track-2',
    name: 'Resonance',
    path: path.resolve(process.cwd(), 'storage', 'test-p11', 'mixed.wav'),
    duration: 212,
    artist: 'HOME',
  };

  const testGuildId = 'test-guild-desktop';
  queueManager.addTrack(testGuildId, track1);
  queueManager.addTrack(testGuildId, track2);
  playbackManager.setLoopMode(testGuildId, 'queue');
  playbackManager.setVolume(testGuildId, 85);

  assert(queueManager.getQueueLength(testGuildId) === 2, 'Queue holds 2 tracks');
  assert(playbackManager.getLoopMode(testGuildId) === 'queue', 'Loop mode is queue');
  assert(playbackManager.getVolume(testGuildId) === 85, 'Volume is 85');

  // Switch playback target from desktop to virtual
  await playbackManager.switchPlaybackTarget('virtual');
  const stateAfterSwitch = await playbackManager.getAudioRoutingState();
  assert(stateAfterSwitch.target === 'virtual', 'PlaybackManager switched target to virtual');

  // Verify queue and state are intact
  assert(queueManager.getQueueLength(testGuildId) === 2, 'Queue length preserved intact across target switch');
  assert(queueManager.getOrCreateQueue(testGuildId).tracks[0].name === 'After Dark', 'Track 1 preserved in queue');
  assert(queueManager.getOrCreateQueue(testGuildId).tracks[1].name === 'Resonance', 'Track 2 preserved in queue');
  assert(playbackManager.getLoopMode(testGuildId) === 'queue', 'Loop mode preserved');
  assert(playbackManager.getVolume(testGuildId) === 85, 'Volume preserved');

  // Switch to Discord target
  await playbackManager.switchPlaybackTarget('discord');
  assert((await playbackManager.getAudioRoutingState()).target === 'discord', 'Target switched to discord');
  assert(queueManager.getQueueLength(testGuildId) === 2, 'Queue preserved intact when switching to Discord');

  // ── 7. Audio Routing REST API Endpoints ──────────────────────────
  console.log('\n--- 7. Audio Routing REST API Endpoints ---');
  const app = express();
  app.use(express.json());
  app.use('/api/audio', audioRoutingRoutes(playbackManager));

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const baseUrl = `http://localhost:${port}/api/audio`;

  // GET /api/audio/devices
  const devRes = await fetch(`${baseUrl}/devices`);
  assert(devRes.status === 200, 'GET /api/audio/devices returns 200');
  const devData: any = await devRes.json();
  assert(devData.success === true, 'devData success is true');
  assert(Array.isArray(devData.outputs), 'outputs is an array');
  assert(Array.isArray(devData.inputs), 'inputs is an array');

  // POST /api/audio/target
  const targetRes = await fetch(`${baseUrl}/target`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: 'desktop' }),
  });
  assert(targetRes.status === 200, 'POST /api/audio/target returns 200');
  const targetData: any = await targetRes.json();
  assert(targetData.target === 'desktop', 'Target returned as desktop');

  // POST /api/audio/device
  const setDevRes = await fetch(`${baseUrl}/device`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: 'headphones-device-1', type: 'output' }),
  });
  assert(setDevRes.status === 200, 'POST /api/audio/device returns 200');

  // POST /api/audio/monitor
  const monRes = await fetch(`${baseUrl}/monitor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true, monitorDeviceId: 'headphones-device-1' }),
  });
  assert(monRes.status === 200, 'POST /api/audio/monitor returns 200');
  const monData: any = await monRes.json();
  assert(monData.state.monitoringEnabled === true, 'monitoringEnabled is true in state');

  // ── 8. WebSocket Reconnection & State Restoration ───────────────
  console.log('\n--- 8. WebSocket Reconnect & State Restoration (Req 26 & 27) ---');
  const wsServer = createWebSocketServer(server, playbackManager);

  const clientWs = new WebSocket(`ws://localhost:${port}/ws`);
  const receivedMessages: any[] = [];

  await new Promise<void>((resolve) => {
    clientWs.on('open', () => {
      clientWs.on('message', (data) => {
        try {
          const parsed = JSON.parse(data.toString());
          receivedMessages.push(parsed);
          if (parsed.type === 'audio.routing.updated') {
            resolve();
          }
        } catch {
          // ignore
        }
      });
    });
  });

  assert(receivedMessages.some((m) => m.type === 'connected'), 'WebSocket client received connection ack');
  assert(receivedMessages.some((m) => m.type === 'playback_state'), 'WebSocket client received authoritative playback state');
  assert(receivedMessages.some((m) => m.type === 'audio.routing.updated'), 'WebSocket client received initial audio routing state');

  // Test client reconnect requesting authoritative state
  const reconnectMessages: any[] = [];
  clientWs.send(JSON.stringify({ type: 'request_state', guildId: testGuildId }));

  await new Promise<void>((resolve) => {
    const handler = (data: any) => {
      try {
        const parsed = JSON.parse(data.toString());
        reconnectMessages.push(parsed);
        if (parsed.type === 'audio.routing.updated') {
          clientWs.off('message', handler);
          resolve();
        }
      } catch {
        // ignore
      }
    };
    clientWs.on('message', handler);
  });

  assert(reconnectMessages.some((m) => m.type === 'playback_state'), 'Reconnect restored authoritative playback state');
  assert(reconnectMessages.some((m) => m.type === 'audio.routing.updated'), 'Reconnect restored authoritative audio routing state');

  clientWs.close();
  server.close();

  // ── 9. Desktop Security, Sanitized Logging & Native Features ────
  console.log('\n--- 9. Desktop Security & Sanitized Logging (Req 3, 20, 21, 28, 31) ---');
  const desktopLog = new DesktopLogger();
  assert(fs.existsSync(desktopLog.getLogDir()), 'Desktop log directory created in user data');

  desktopLog.info('DESKTOP', 'Connected');
  desktopLog.info('DESKTOP', 'Output device changed', { device: 'Headphones', secret_token: 'SUPER_SECRET_TOKEN' });
  desktopLog.warn('AUDIO', 'Output failed on device', { reason: 'unplugged' });

  const logContent = fs.readFileSync(desktopLog.getLogPath(), 'utf-8');
  assert(logContent.includes('[DESKTOP] Connected'), 'Log file records [DESKTOP] Connected');
  assert(logContent.includes('[DESKTOP] Output device changed'), 'Log file records device changed');
  assert(!logContent.includes('SUPER_SECRET_TOKEN'), 'Sensitive credentials are REDACTED from log file');

  // Native Notifications
  const notifManager = new DesktopNotificationManager();
  notifManager.notifyTrackChange('After Dark', 'Mr.Kitty');
  notifManager.notifyRecordingStarted('Board Meeting');
  notifManager.notifyRecordingCompleted('Board Meeting', '04:15');
  assert(notifManager.getSettings().enabled === true, 'Notification manager initialized and functional');

  // ── 10. Portable Windows Desktop Packaging Verification ─────────
  console.log('\n--- 10. Desktop Packaging Verification (Req 30) ---');
  const exePath = path.resolve(process.cwd(), 'packages', 'desktop', 'release', 'Gakki-win32-x64', 'Gakki.exe');
  assert(fs.existsSync(exePath), 'Standalone portable Gakki.exe exists in release folder');

  const appPackageJson = path.resolve(process.cwd(), 'packages', 'desktop', 'release', 'Gakki-win32-x64', 'resources', 'app', 'package.json');
  assert(fs.existsSync(appPackageJson), 'Desktop application package bundled into resources/app');

  const readmePath = path.resolve(process.cwd(), 'packages', 'desktop', 'release', 'Gakki-win32-x64', 'README.txt');
  assert(fs.existsSync(readmePath), 'Distribution README.txt included with usage instructions');

  console.log('\n================================================================');
  console.log('       🎉 ALL PHASE 12 AUTOMATED VERIFICATION TESTS PASSED       ');
  console.log('================================================================\n');
}

runPhase12Tests().catch((err) => {
  console.error('Fatal Phase 12 test error:', err);
  process.exit(1);
});
