import * as fs from 'node:fs';
import * as path from 'node:path';
import { EndBehaviorType, type VoiceConnection } from '@discordjs/voice';
import type { Client } from 'discord.js';
import * as prism from 'prism-media';
import {
  createLogger,
  type RecordingManager,
  type TranscriptionManager,
  type VoiceRecordingSession,
  type RecordingResult,
  pcmToWav,
} from '@gakki/core';
import type { DiscordVoiceAdapter } from '../discord/voice-adapter';
import type { WsBroadcastFunction } from '../websocket';

const logger = createLogger('voice-receiver');

interface ActiveUserStream {
  userId: string;
  displayName: string;
  pcmPath: string;
  pcmStream: fs.WriteStream;
  firstAudioMs: number;
  lastAudioMs: number;
  decoder: any;
  opusStream: any;
}

interface ActiveRecordingState {
  sessionId: string;
  guildId: string;
  voiceChannelId: string;
  startedBy: string;
  startTimeMs: number;
  timer: NodeJS.Timeout;
  userStreams: Map<string, ActiveUserStream>;
}

export class VoiceReceiverManager {
  private readonly activeRecordings = new Map<string, ActiveRecordingState>(); // guildId -> state
  private voiceAdapter?: DiscordVoiceAdapter;

  constructor(
    voiceAdapter: DiscordVoiceAdapter | undefined,
    private readonly recordingManager: RecordingManager,
    private readonly transcriptionManager?: TranscriptionManager,
    private readonly broadcastWs?: WsBroadcastFunction
  ) {
    this.voiceAdapter = voiceAdapter;
  }

  public setVoiceAdapter(adapter: DiscordVoiceAdapter): void {
    this.voiceAdapter = adapter;
  }

  public getRecordingManager(): RecordingManager {
    return this.recordingManager;
  }

  public getTranscriptionManager(): TranscriptionManager | undefined {
    return this.transcriptionManager;
  }

  /**
   * Start recording in a guild voice channel.
   */
  async startRecording(
    guildId: string,
    options: {
      channelId?: string;
      startedBy: string;
      title?: string;
      visibility?: 'PRIVATE' | 'GUILD';
    }
  ): Promise<VoiceRecordingSession> {
    if (this.activeRecordings.has(guildId)) {
      throw new Error('A voice recording is already active in this server.');
    }

    if (!this.voiceAdapter) {
      throw new Error('Discord voice adapter is not connected.');
    }

    let connection = this.voiceAdapter.getConnection(guildId);
    let channelId = options.channelId || this.voiceAdapter.getChannelId(guildId);

    if (!connection || !channelId) {
      if (!options.channelId) {
        throw new Error('Bot is not currently in a voice channel. Specify channelId to record.');
      }
      await this.voiceAdapter.joinVoice(guildId, options.channelId);
      connection = this.voiceAdapter.getConnection(guildId);
      channelId = options.channelId;
    }

    if (!connection) {
      throw new Error('Failed to establish voice connection for recording.');
    }

    // 1. Create persistent session in DB
    const session = await this.recordingManager.createSession({
      guildId,
      voiceChannelId: channelId,
      startedBy: options.startedBy,
      title: options.title,
      visibility: options.visibility,
    });

    const sessionId = session.id;
    const startTimeMs = Date.now();
    const userStreams = new Map<string, ActiveUserStream>();
    const sessionTmpDir = path.join(this.recordingManager.getTmpRoot(), sessionId, 'users');
    fs.mkdirSync(sessionTmpDir, { recursive: true });

    // 2. Set auto-stop timer (default 180 minutes limit)
    const maxMinutes = parseInt(process.env.MAX_RECORDING_DURATION_MINUTES || '180', 10);
    const timer = setTimeout(() => {
      logger.warn({ guildId, sessionId }, '[RECORDING] Max recording duration reached, auto-stopping');
      this.stopRecording(guildId, 'system-max-duration').catch((err) => {
        logger.error({ err, guildId, sessionId }, 'Failed to auto-stop recording on timeout');
      });
    }, maxMinutes * 60 * 1000);

    const recordingState: ActiveRecordingState = {
      sessionId,
      guildId,
      voiceChannelId: channelId,
      startedBy: options.startedBy,
      startTimeMs,
      timer,
      userStreams,
    };
    this.activeRecordings.set(guildId, recordingState);

    // 3. Attach speaking listeners to connection receiver
    const receiver = connection.receiver;

    receiver.speaking.on('start', async (userId) => {
      if (!this.activeRecordings.has(guildId)) return;
      const state = this.activeRecordings.get(guildId)!;
      if (state.sessionId !== sessionId) return;

      const elapsedMs = Date.now() - state.startTimeMs;

      // Check if user stream already established
      if (state.userStreams.has(userId)) {
        const uStream = state.userStreams.get(userId)!;
        uStream.lastAudioMs = elapsedMs;
        return;
      }

      // Resolve user display name
      const guild = this.voiceAdapter?.getClient()?.guilds.cache.get(guildId);
      const member = guild?.members.cache.get(userId);
      const displayName = member?.displayName || member?.user?.username || `User ${userId.slice(0, 4)}`;

      // Register participant in database
      const userWavKey = `storage/recordings/${sessionId}/users/${userId}.wav`;
      await this.recordingManager.addOrUpdateParticipant(sessionId, {
        userId,
        displayName,
        firstAudioTimestamp: elapsedMs,
        audioStorageKey: userWavKey,
      });

      // Subscribe to user Opus audio
      try {
        const pcmPath = path.join(sessionTmpDir, `${userId}.pcm`);
        const pcmFileStream = fs.createWriteStream(pcmPath, { flags: 'a' });

        const opusStream = receiver.subscribe(userId, {
          end: {
            behavior: EndBehaviorType.Manual,
          },
        });

        // prism-media Opus decoder: 48kHz, 2 channels (stereo), 16-bit PCM
        const opusDecoder = new (prism as any).opus.Decoder({
          rate: 48000,
          channels: 2,
          frameSize: 960,
        });

        opusStream.pipe(opusDecoder).pipe(pcmFileStream);

        const activeStream: ActiveUserStream = {
          userId,
          displayName,
          pcmPath,
          pcmStream: pcmFileStream,
          firstAudioMs: elapsedMs,
          lastAudioMs: elapsedMs,
          decoder: opusDecoder,
          opusStream,
        };

        state.userStreams.set(userId, activeStream);

        logger.info(
          { userId, displayName, sessionId, firstAudioMs: elapsedMs },
          '[RECORDING] Subscribed to participant audio stream: %s',
          displayName
        );
      } catch (err) {
        logger.error({ err, userId, sessionId }, 'Failed to subscribe to user audio stream');
      }
    });

    receiver.speaking.on('end', (userId) => {
      const state = this.activeRecordings.get(guildId);
      if (state && state.userStreams.has(userId)) {
        const uStream = state.userStreams.get(userId)!;
        uStream.lastAudioMs = Date.now() - state.startTimeMs;
      }
    });

    // Broadcast WebSocket notification
    if (this.broadcastWs) {
      this.broadcastWs({
        type: 'recording_started' as any,
        recording: session,
      } as any);
    }

    return session;
  }

  /**
   * Stop an active recording, mix per-user audio tracks, and trigger async transcription.
   */
  async stopRecording(guildId: string, actorUserId: string = 'system'): Promise<RecordingResult> {
    const state = this.activeRecordings.get(guildId);
    if (!state) {
      throw new Error('No active voice recording found for this server.');
    }

    clearTimeout(state.timer);
    this.activeRecordings.delete(guildId);

    const { sessionId, voiceChannelId, startTimeMs, userStreams } = state;
    const endedAtMs = Date.now();
    const durationSeconds = Math.max(1, Math.round((endedAtMs - startTimeMs) / 1000));

    logger.info(
      { sessionId, guildId, durationSeconds, streamCount: userStreams.size },
      '[RECORDING] Stopping recording session, finalizing audio streams...'
    );

    // 1. Close and flush all participant streams
    const sessionDir = path.join(this.recordingManager.getStorageRoot(), sessionId);
    const usersWavDir = path.join(sessionDir, 'users');
    fs.mkdirSync(usersWavDir, { recursive: true });

    const mixInputs: Array<{
      userId: string;
      displayName: string;
      filePath: string;
      startOffsetMs: number;
    }> = [];

    for (const [userId, uStream] of userStreams.entries()) {
      try {
        if (uStream.opusStream) {
          uStream.opusStream.destroy();
        }
        if (uStream.decoder) {
          uStream.decoder.destroy();
        }
        uStream.pcmStream.end();

        // Allow write stream to flush
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Read raw PCM and wrap into clean WAV
        if (fs.existsSync(uStream.pcmPath)) {
          const pcmBuf = fs.readFileSync(uStream.pcmPath);
          if (pcmBuf.length > 0) {
            const userWavPath = path.join(usersWavDir, `${userId}.wav`);
            const wavBuf = pcmToWav(pcmBuf, 48000, 2, 16);
            fs.writeFileSync(userWavPath, wavBuf);

            mixInputs.push({
              userId,
              displayName: uStream.displayName,
              filePath: userWavPath,
              startOffsetMs: uStream.firstAudioMs,
            });

            // Update participant record with final audio timestamps
            await this.recordingManager.markParticipantLeft(sessionId, userId, uStream.lastAudioMs);
          }
        }
      } catch (err) {
        logger.error({ err, userId, sessionId }, 'Error finalizing participant audio stream');
      }
    }

    // 2. Mix tracks into master mixed.wav
    const outputWavPath = path.join(sessionDir, 'mixed.wav');
    const mixer = this.recordingManager.getMixer();
    const mixResult = await mixer.mixTracks(mixInputs, outputWavPath);

    // 3. Mark session complete in database and write metadata.json
    const completedSession = await this.recordingManager.completeSession(
      sessionId,
      mixResult,
      actorUserId
    );

    // 4. Trigger asynchronous transcription job
    if (this.transcriptionManager) {
      this.transcriptionManager.queueTranscription(sessionId, actorUserId).catch((err) => {
        logger.error({ err, sessionId }, 'Failed to queue transcription for recording');
      });
    }

    // 5. Broadcast WebSocket notification
    if (this.broadcastWs) {
      this.broadcastWs({
        type: 'recording_stopped' as any,
        recording: completedSession,
      } as any);
    }

    return {
      sessionId,
      guildId,
      voiceChannelId,
      startedAt: completedSession.startedAt,
      endedAt: completedSession.endedAt || new Date().toISOString(),
      durationSeconds: mixResult.durationSeconds,
      format: 'wav',
      storageKey: mixResult.mixedFilePath,
      fileSizeBytes: mixResult.fileSizeBytes,
      participantCount: mixResult.participantCount,
      participants: completedSession.participants,
      status: 'COMPLETED',
    };
  }

  /**
   * Get active recording for a guild (if any).
   */
  async getActiveRecording(guildId: string): Promise<VoiceRecordingSession | null> {
    const live = this.activeRecordings.get(guildId);
    if (live) {
      const session = await this.recordingManager.getSession(live.sessionId);
      if (session) {
        // Calculate live duration
        session.duration = Math.round((Date.now() - live.startTimeMs) / 1000);
        return session;
      }
    }
    return this.recordingManager.getActiveSession(guildId);
  }

  /**
   * Check if recording is active.
   */
  isRecording(guildId: string): boolean {
    return this.activeRecordings.has(guildId);
  }

  /**
   * Gracefully stop all active recordings during server shutdown.
   */
  async shutdown(): Promise<void> {
    const activeGuildIds = Array.from(this.activeRecordings.keys());
    logger.info({ count: activeGuildIds.length }, '[RECORDING] Shutting down voice receivers...');
    for (const guildId of activeGuildIds) {
      try {
        await this.stopRecording(guildId, 'system-shutdown');
      } catch (err) {
        logger.error({ err, guildId }, 'Error stopping recording during shutdown');
      }
    }
  }
}

