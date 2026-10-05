/**
 * Platform-Neutral Voice Session Manager
 *
 * Implements Requirements 30, 31, 32:
 * - Unified multi-platform voice session orchestration (Discord, Desktop, Google Meet).
 * - Tracks connected participants, audio routing endpoints, and capability sets.
 * - Bridges active platform context into voice command execution.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type {
  PlatformParticipant,
  VoicePlatformAdapter,
  VoicePlatformCapabilities,
  VoiceSession,
} from '../types/platform';
import type { VoiceCommandContext } from '../types/voice-command';
import { CommandPermissionLevel } from '../types/permissions';
import { createLogger } from '../utils/logger';

const logger = createLogger('voice-session-manager');

export class VoiceSessionManager extends EventEmitter {
  private readonly sessions = new Map<string, VoiceSession>(); // sessionId -> VoiceSession
  private readonly adapters = new Map<string, VoicePlatformAdapter>(); // platform -> Adapter

  constructor() {
    super();
  }

  registerAdapter(adapter: VoicePlatformAdapter): void {
    this.adapters.set(adapter.platform, adapter);
    logger.info({ platform: adapter.platform }, 'Registered voice platform adapter');
  }

  getAdapter(platform: string): VoicePlatformAdapter | undefined {
    return this.adapters.get(platform);
  }

  getAllAdapters(): VoicePlatformAdapter[] {
    return Array.from(this.adapters.values());
  }

  /**
   * Create and register an active multi-platform voice session.
   */
  createSession(options: {
    platform: string;
    guildId?: string;
    channelId?: string;
    spaceId?: string;
    capabilities: VoicePlatformCapabilities;
    initialParticipants?: PlatformParticipant[];
    audioInputs?: string[];
    audioOutputs?: string[];
  }): VoiceSession {
    const sessionId = `vsess_${randomUUID().slice(0, 8)}`;
    const participantsMap = new Map<string, PlatformParticipant>();

    if (options.initialParticipants) {
      for (const p of options.initialParticipants) {
        participantsMap.set(p.platformParticipantId, p);
      }
    }

    const session: VoiceSession = {
      id: sessionId,
      platform: options.platform,
      sessionId,
      guildId: options.guildId,
      channelId: options.channelId,
      spaceId: options.spaceId,
      participants: participantsMap,
      audioInputs: options.audioInputs || ['default-input'],
      audioOutputs: options.audioOutputs || ['default-output'],
      capabilities: options.capabilities,
      status: 'active',
      startedAt: new Date(),
    };

    this.sessions.set(sessionId, session);
    logger.info({ sessionId, platform: options.platform }, 'Created platform voice session');
    this.emit('session_created', session);
    return session;
  }

  getSession(sessionId: string): VoiceSession | undefined {
    return this.sessions.get(sessionId);
  }

  getActiveSessionForPlatform(platform: string, guildId?: string): VoiceSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.platform === platform && session.status === 'active') {
        if (!guildId || session.guildId === guildId) {
          return session;
        }
      }
    }
    return undefined;
  }

  /**
   * Adds or updates a participant in the voice session.
   */
  upsertParticipant(sessionId: string, participant: PlatformParticipant): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.participants.set(participant.platformParticipantId, {
      ...participant,
      joinedAt: participant.joinedAt || new Date(),
    });

    this.emit('participant_updated', { sessionId, participant });
  }

  /**
   * Removes a participant from a session.
   */
  removeParticipant(sessionId: string, participantId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const existing = session.participants.get(participantId);
    if (existing) {
      existing.leftAt = new Date();
      session.participants.delete(participantId);
      this.emit('participant_left', { sessionId, participantId });
    }
  }

  /**
   * Closes a voice session.
   */
  closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.status = 'closed';
    session.endedAt = new Date();
    this.emit('session_closed', session);
    logger.info({ sessionId, platform: session.platform }, 'Closed platform voice session');
  }

  /**
   * Constructs safe, minimal voice command execution context for a session.
   * Requirement 32: Do not expose unnecessary private metadata to the AI model.
   */
  createCommandContext(options: {
    sessionId?: string;
    platform?: string;
    guildId?: string;
    userId?: string;
    userDisplayName?: string;
    permissionLevel?: CommandPermissionLevel;
    currentTrackId?: string | null;
    currentTrackTitle?: string | null;
    currentArtist?: string | null;
  }): VoiceCommandContext {
    const session = options.sessionId
      ? this.sessions.get(options.sessionId)
      : undefined;

    return {
      platform: options.platform || session?.platform || 'desktop',
      guildId: options.guildId || session?.guildId,
      voiceChannelId: session?.channelId,
      userId: options.userId || 'user_local',
      userDisplayName: options.userDisplayName || 'User',
      permissionLevel: options.permissionLevel ?? CommandPermissionLevel.USER,
      currentTrackId: options.currentTrackId,
      currentTrackTitle: options.currentTrackTitle,
      currentArtist: options.currentArtist,
    };
  }
}
