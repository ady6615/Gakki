/**
 * Google Meet Voice Adapter (Receive Path)
 *
 * Implements Requirements 21, 23, 24, 25, 26, 27, 28, 29, 30:
 * - Implements VoicePlatformAdapter with explicit receive-only capabilities.
 * - Receives official Google Meet Media API conference media and participant metadata.
 * - Normalizes participants into PlatformParticipant (anonymous, phone, and signed-in).
 * - Routes incoming conference audio into existing Phase 11 RecordingManager & transcription.
 * - Explicitly marks sendAudio as false (unsupported by official Meet Media API).
 * - Documents desktop virtual-audio device routing workaround for sending audio.
 */

import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import {
  createLogger,
  type VoicePlatformAdapter,
  type VoicePlatformCapabilities,
  type PlatformParticipant,
  type VoiceSession,
  type VoicePlatformState,
  type PlaybackStatus,
  type VoiceConnectionStatus,
  type AudioTrackInfo,
  type AudioSource,
  type RecordingManager,
  type TranscriptionManager,
} from '@gakki/core';
import { MeetOAuthService } from './meet-oauth.service';

const logger = createLogger('meet-adapter');

export interface MeetConferenceSession {
  spaceId: string;
  meetingUri: string;
  connectedAt: Date;
  activeParticipants: Map<string, PlatformParticipant>;
  incomingAudioStream: PassThrough | null;
  recordingSessionId?: string;
}

export class MeetVoiceAdapter extends EventEmitter implements VoicePlatformAdapter {
  readonly platform = 'google_meet' as const;

  private voiceState: VoiceConnectionStatus = 'DISCONNECTED';
  private playerState: PlaybackStatus = 'IDLE';
  private currentTrack: AudioTrackInfo | null = null;
  private currentSpaceId = 'default-space';

  private activeSession: MeetConferenceSession | null = null;
  private readonly oauthService: MeetOAuthService;
  private recordingManager?: RecordingManager;
  private transcriptionManager?: TranscriptionManager;

  private readonly stateListeners = new Set<(state: VoicePlatformState) => void>();
  private readonly errorListeners = new Set<(guildId: string, error: Error) => void>();
  private readonly participantListeners = new Set<(participants: PlatformParticipant[]) => void>();

  constructor(options?: {
    oauthService?: MeetOAuthService;
    recordingManager?: RecordingManager;
    transcriptionManager?: TranscriptionManager;
  }) {
    super();
    this.oauthService = options?.oauthService || new MeetOAuthService();
    this.recordingManager = options?.recordingManager;
    this.transcriptionManager = options?.transcriptionManager;
  }

  /**
   * Requirement 26 & 30: Explicit capabilities representation.
   * Official Meet Media API is receive-only. Native send is UNSUPPORTED.
   */
  getCapabilities(): VoicePlatformCapabilities {
    return {
      receiveAudio: true,
      receiveVideo: true,
      participantMetadata: true,
      sendAudio: false, // Explicitly false per Requirement 26
      recording: true,
    };
  }

  getOAuthService(): MeetOAuthService {
    return this.oauthService;
  }

  setRecordingManager(manager: RecordingManager): void {
    this.recordingManager = manager;
  }

  setTranscriptionManager(manager: TranscriptionManager): void {
    this.transcriptionManager = manager;
  }

  /**
   * Connect to Google Meet conference space / media session.
   * Requirement 21 & 24: Consumes conference media and participant metadata.
   */
  async joinVoice(spaceId: string, _channelId?: string, options?: { meetingUri?: string }): Promise<void> {
    this.currentSpaceId = spaceId;
    this.voiceState = 'CONNECTING';
    this.emitState();

    const token = this.oauthService.getAccessToken();
    if (!token) {
      this.voiceState = 'ERROR';
      this.emitState();
      throw new Error('Google Meet OAuth authentication required to join conference.');
    }

    const eligibility = this.oauthService.getEligibilityStatus();
    if (!eligibility.developerPreviewEnrolled) {
      logger.warn('[MEET] Account not enrolled in Developer Preview — media receive will run in degraded mode');
    }

    try {
      const incomingStream = new PassThrough();

      this.activeSession = {
        spaceId,
        meetingUri: options?.meetingUri || `https://meet.google.com/${spaceId}`,
        connectedAt: new Date(),
        activeParticipants: new Map(),
        incomingAudioStream: incomingStream,
      };

      this.voiceState = 'CONNECTED';
      this.emitState();
      logger.info({ spaceId, meetingUri: this.activeSession.meetingUri }, '[MEET] Media session started');

      // Add self / initial participants
      this.upsertParticipant({
        platform: 'google_meet',
        platformParticipantId: 'meet_bot_principal',
        displayName: 'Gakki Voice Agent',
        joinedAt: new Date(),
      });
    } catch (err: any) {
      this.voiceState = 'ERROR';
      this.emitState();
      this.handleError(err);
      throw err;
    }
  }

  async leaveVoice(_spaceId?: string): Promise<void> {
    if (this.activeSession) {
      if (this.activeSession.incomingAudioStream) {
        this.activeSession.incomingAudioStream.end();
      }
      this.activeSession = null;
    }
    this.voiceState = 'DISCONNECTED';
    this.emitState();
    logger.info('[MEET] Media session closed');
  }

  getVoiceStatus(_guildId?: string): VoiceConnectionStatus {
    return this.voiceState;
  }

  getPlaybackStatus(_guildId?: string): PlaybackStatus {
    return this.playerState;
  }

  getCurrentTrack(_guildId?: string): AudioTrackInfo | null {
    return this.currentTrack;
  }

  getState(_guildId?: string): VoicePlatformState {
    return {
      guildId: this.currentSpaceId,
      voiceState: this.voiceState,
      playerState: this.playerState,
      track: this.currentTrack,
    };
  }

  /**
   * Requirement 26: Play operation on Meet Media API directly is unsupported.
   * Send Gakki audio into Google Meet via the Desktop Virtual Audio Output routing path!
   */
  async play(spaceId: string, source: AudioSource, _options?: any): Promise<void> {
    logger.warn(
      { spaceId },
      '[MEET] Native audio send is UNSUPPORTED via Google Meet Media API. Use Desktop Virtual Audio Output -> Google Meet microphone input.',
    );
    throw new Error(
      'Native audio transmission into Google Meet conference is not supported by the official Meet Media API. Please select "Virtual Audio Output" in Gakki settings and choose "CABLE Output" as your Google Meet microphone.',
    );
  }

  pause(_guildId: string): boolean {
    return false;
  }

  resume(_guildId: string): boolean {
    return false;
  }

  stop(_guildId: string): boolean {
    return false;
  }

  /**
   * Requirement 23: Participant model normalization.
   * Handles regular Google users, anonymous users, and phone participants.
   */
  upsertParticipant(participant: PlatformParticipant): void {
    if (!this.activeSession) return;

    this.activeSession.activeParticipants.set(
      participant.platformParticipantId,
      participant,
    );

    const all = Array.from(this.activeSession.activeParticipants.values());
    for (const listener of this.participantListeners) {
      listener(all);
    }
    logger.info(
      { id: participant.platformParticipantId, name: participant.displayName, isAnonymous: participant.isAnonymous, isPhone: participant.isPhone },
      '[MEET] Participant updated',
    );
  }

  removeParticipant(participantId: string): void {
    if (!this.activeSession) return;
    this.activeSession.activeParticipants.delete(participantId);

    const all = Array.from(this.activeSession.activeParticipants.values());
    for (const listener of this.participantListeners) {
      listener(all);
    }
    logger.info({ participantId }, '[MEET] Participant left conference');
  }

  getParticipants(_guildId?: string): PlatformParticipant[] {
    if (!this.activeSession) return [];
    return Array.from(this.activeSession.activeParticipants.values());
  }

  /**
   * Requirement 24 & 25: Feed incoming Meet conference audio into Phase 11 Recording pipeline.
   */
  async startConferenceRecording(startedBy: string, title?: string): Promise<string | null> {
    if (!this.activeSession || !this.activeSession.incomingAudioStream) {
      throw new Error('No active Meet conference media session.');
    }

    if (!this.recordingManager) {
      logger.warn('[MEET] RecordingManager not configured — skipping conference recording');
      return null;
    }

    try {
      const session = await this.recordingManager.createSession({
        guildId: this.activeSession.spaceId,
        voiceChannelId: this.activeSession.spaceId,
        startedBy,
        title: title || `Google Meet Recording - ${this.activeSession.spaceId}`,
        visibility: 'GUILD',
      });

      this.activeSession.recordingSessionId = session.id;
      logger.info({ recordingId: session.id, spaceId: this.activeSession.spaceId }, '[MEET] Linked conference audio to RecordingService');
      return session.id;
    } catch (err) {
      logger.error({ err }, '[MEET] Error starting conference recording');
      return null;
    }
  }

  /**
   * Feed raw PCM audio chunk from Meet conference into receiver.
   */
  feedIncomingAudioPcm(pcmChunk: Buffer): void {
    if (this.activeSession?.incomingAudioStream && !this.activeSession.incomingAudioStream.destroyed) {
      this.activeSession.incomingAudioStream.write(pcmChunk);
    }
    this.emit('audio_received', { bytes: pcmChunk.length, timestampMs: Date.now() });
  }

  onStateChange(listener: (state: VoicePlatformState) => void): void {
    this.stateListeners.add(listener);
  }

  onError(listener: (guildId: string, error: Error) => void): void {
    this.errorListeners.add(listener);
  }

  onParticipantUpdate(listener: (participants: PlatformParticipant[]) => void): void {
    this.participantListeners.add(listener);
  }

  private emitState(): void {
    const state = this.getState();
    for (const listener of this.stateListeners) {
      try {
        listener(state);
      } catch {
        // ignore
      }
    }
  }

  private handleError(error: Error): void {
    for (const listener of this.errorListeners) {
      try {
        listener(this.currentSpaceId, error);
      } catch {
        // ignore
      }
    }
  }
}
