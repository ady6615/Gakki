import * as fs from 'node:fs';
import * as path from 'node:path';
import type pg from 'pg';
import { createLogger } from '../utils/logger';
import type {
  VoiceRecordingSession,
  RecordingStartOptions,
  ParticipantRecordingMetadata,
  RecordingFilterOptions,
  RecordingMetadataJSON,
  RecordingAuditEvent,
} from '../types/recording';
import { RecordingMixer, type MixResult } from '../audio/recording-mixer';
import type { TranscriptionManager } from '../transcription/transcription.manager';

const logger = createLogger('recording-manager');

export class RecordingManager {
  private readonly storageRoot: string;
  private readonly tmpRoot: string;
  private readonly mixer: RecordingMixer;

  constructor(
    private readonly pool: pg.Pool,
    options: {
      storageRoot?: string;
      tmpRoot?: string;
      transcriptionManager?: TranscriptionManager;
    } = {}
  ) {
    this.storageRoot = options.storageRoot || path.resolve(process.cwd(), 'storage', 'recordings');
    this.tmpRoot = options.tmpRoot || path.resolve(process.cwd(), 'storage', 'tmp', 'recordings');
    this.mixer = new RecordingMixer();

    // Ensure storage roots exist
    if (!fs.existsSync(this.storageRoot)) {
      fs.mkdirSync(this.storageRoot, { recursive: true });
    }
    if (!fs.existsSync(this.tmpRoot)) {
      fs.mkdirSync(this.tmpRoot, { recursive: true });
    }
  }

  /**
   * Create and initialize a new persistent recording session.
   */
  async createSession(options: RecordingStartOptions): Promise<VoiceRecordingSession> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const title = options.title || `Recording ${new Date().toLocaleDateString('en-US')}`;
      const format = options.format || 'wav';
      const visibility = options.visibility || 'GUILD';

      const insertRes = await client.query<{
        id: string;
        created_at: Date;
        updated_at: Date;
        started_at: Date;
      }>(
        `INSERT INTO recording_sessions (
           guild_id, voice_channel_id, started_by, started_at,
           duration, status, format, file_size_bytes, transcription_status,
           visibility, title, created_at, updated_at
         ) VALUES ($1, $2, $3, NOW(), 0, 'RECORDING', $4, 0, 'NONE', $5, $6, NOW(), NOW())
         RETURNING id, created_at, updated_at, started_at`,
        [options.guildId, options.voiceChannelId, options.startedBy, format, visibility, title]
      );

      const row = insertRes.rows[0];
      const sessionId = row.id;

      // Create session storage directories
      const sessionDir = path.join(this.storageRoot, sessionId);
      const userTracksDir = path.join(sessionDir, 'users');
      const sessionTmpDir = path.join(this.tmpRoot, sessionId);

      fs.mkdirSync(userTracksDir, { recursive: true });
      fs.mkdirSync(sessionTmpDir, { recursive: true });

      // Log audit event
      await client.query(
        `INSERT INTO recording_audit_events (recording_id, actor_user_id, action, timestamp, details)
         VALUES ($1, $2, 'STARTED', NOW(), $3)`,
        [sessionId, options.startedBy, `Recording started in voice channel ${options.voiceChannelId}`]
      );

      await client.query('COMMIT');

      logger.info({ sessionId, guildId: options.guildId }, '[RECORDING] Created new recording session');

      return {
        id: sessionId,
        guildId: options.guildId,
        voiceChannelId: options.voiceChannelId,
        startedBy: options.startedBy,
        startedAt: row.started_at.toISOString(),
        duration: 0,
        status: 'RECORDING',
        format,
        fileSizeBytes: 0,
        transcriptionStatus: 'NONE',
        visibility,
        title,
        participants: [],
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      };
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ err, options }, '[RECORDING] Failed to create recording session');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Track participant joining or speaking in recording.
   */
  async addOrUpdateParticipant(
    recordingId: string,
    metadata: {
      userId: string;
      displayName: string;
      firstAudioTimestamp?: number;
      audioStorageKey?: string;
    }
  ): Promise<ParticipantRecordingMetadata> {
    const existing = await this.pool.query(
      `SELECT * FROM recording_participants WHERE recording_id = $1 AND user_id = $2`,
      [recordingId, metadata.userId]
    );

    if (existing.rows.length > 0) {
      const p = existing.rows[0];
      const firstAudio = Math.min(
        p.first_audio_timestamp || 0,
        metadata.firstAudioTimestamp !== undefined ? metadata.firstAudioTimestamp : p.first_audio_timestamp || 0
      );

      await this.pool.query(
        `UPDATE recording_participants
         SET display_name = $3,
             first_audio_timestamp = $4,
             audio_storage_key = COALESCE($5, audio_storage_key)
         WHERE recording_id = $1 AND user_id = $2`,
        [recordingId, metadata.userId, metadata.displayName, firstAudio, metadata.audioStorageKey]
      );

      return {
        id: p.id,
        recordingId,
        userId: metadata.userId,
        displayName: metadata.displayName,
        joinedAt: p.joined_at.toISOString(),
        leftAt: p.left_at ? p.left_at.toISOString() : undefined,
        firstAudioTimestamp: firstAudio,
        lastAudioTimestamp: p.last_audio_timestamp || 0,
        audioStorageKey: metadata.audioStorageKey || p.audio_storage_key,
      };
    }

    const insertRes = await this.pool.query<{ id: string; joined_at: Date }>(
      `INSERT INTO recording_participants (
         recording_id, user_id, display_name, joined_at,
         first_audio_timestamp, last_audio_timestamp, audio_storage_key, created_at
       ) VALUES ($1, $2, $3, NOW(), $4, 0, $5, NOW())
       RETURNING id, joined_at`,
      [
        recordingId,
        metadata.userId,
        metadata.displayName,
        metadata.firstAudioTimestamp || 0,
        metadata.audioStorageKey || null,
      ]
    );

    const row = insertRes.rows[0];
    return {
      id: row.id,
      recordingId,
      userId: metadata.userId,
      displayName: metadata.displayName,
      joinedAt: row.joined_at.toISOString(),
      firstAudioTimestamp: metadata.firstAudioTimestamp || 0,
      lastAudioTimestamp: 0,
      audioStorageKey: metadata.audioStorageKey,
    };
  }

  /**
   * Mark participant left and record last audio timestamp.
   */
  async markParticipantLeft(
    recordingId: string,
    userId: string,
    lastAudioTimestamp?: number
  ): Promise<void> {
    await this.pool.query(
      `UPDATE recording_participants
       SET left_at = NOW(),
           last_audio_timestamp = COALESCE($3, last_audio_timestamp)
       WHERE recording_id = $1 AND user_id = $2`,
      [recordingId, userId, lastAudioTimestamp]
    );
  }

  /**
   * Complete recording session after audio mixing finishes.
   */
  async completeSession(
    recordingId: string,
    mixResult: MixResult,
    actorUserId: string = 'system'
  ): Promise<VoiceRecordingSession> {
    const sessionDir = path.join(this.storageRoot, recordingId);
    const metadataPath = path.join(sessionDir, 'metadata.json');

    // Fetch participants
    const participants = await this.getParticipants(recordingId);

    // Write metadata.json file (Requirement 13)
    const sessionRes = await this.pool.query(
      `SELECT * FROM recording_sessions WHERE id = $1`,
      [recordingId]
    );
    if (sessionRes.rows.length === 0) {
      throw new Error(`Recording session ${recordingId} not found`);
    }
    const session = sessionRes.rows[0];

    const metadataJSON: RecordingMetadataJSON = {
      recordingId,
      guildId: session.guild_id,
      voiceChannelId: session.voice_channel_id,
      startedBy: session.started_by,
      startedAt: session.started_at.toISOString(),
      endedAt: new Date().toISOString(),
      durationSeconds: mixResult.durationSeconds,
      format: session.format || 'wav',
      fileSizeBytes: mixResult.fileSizeBytes,
      sampleRate: mixResult.sampleRate,
      channels: mixResult.channels,
      participants: participants.map((p) => ({
        userId: p.userId,
        displayName: p.displayName,
        joinedAt: p.joinedAt,
        leftAt: p.leftAt,
        firstAudioMs: p.firstAudioTimestamp,
        lastAudioMs: p.lastAudioTimestamp,
        audioFile: p.audioStorageKey ? path.basename(p.audioStorageKey) : undefined,
      })),
    };

    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(metadataPath, JSON.stringify(metadataJSON, null, 2), 'utf-8');

    const finalStorageKey = mixResult.mixedFilePath || (mixResult as any).storageKey || '';

    // Update database record
    await this.pool.query(
      `UPDATE recording_sessions
       SET status = 'COMPLETED',
           ended_at = NOW(),
           duration = $2,
           storage_key = $3,
           metadata_storage_key = $4,
           file_size_bytes = $5,
           updated_at = NOW()
       WHERE id = $1`,
      [
        recordingId,
        mixResult.durationSeconds,
        finalStorageKey,
        metadataPath,
        mixResult.fileSizeBytes,
      ]
    );

    // Clean up temporary files in storage/tmp/recordings/<recordingId>/
    const tmpDir = path.join(this.tmpRoot, recordingId);
    if (fs.existsSync(tmpDir)) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        logger.debug({ tmpDir }, '[RECORDING] Cleaned up temporary recording files');
      } catch (err) {
        logger.warn({ err, tmpDir }, 'Failed to delete temporary directory');
      }
    }

    // Log audit event
    await this.pool.query(
      `INSERT INTO recording_audit_events (recording_id, actor_user_id, action, timestamp, details)
       VALUES ($1, $2, 'STOPPED', NOW(), $3)`,
      [
        recordingId,
        actorUserId,
        `Recording stopped. Duration: ${mixResult.durationSeconds}s, Size: ${mixResult.fileSizeBytes} bytes`,
      ]
    );

    const updated = await this.getSession(recordingId);
    return updated!;
  }

  /**
   * Mark a session as FAILED on unexpected crash or unrecoverable error.
   */
  async failSession(recordingId: string, errorMessage: string): Promise<void> {
    await this.pool.query(
      `UPDATE recording_sessions
       SET status = 'FAILED',
           error_message = $2,
           ended_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [recordingId, errorMessage]
    );

    await this.pool.query(
      `INSERT INTO recording_audit_events (recording_id, actor_user_id, action, timestamp, details)
       VALUES ($1, 'system', 'STOPPED', NOW(), $2)`,
      [recordingId, `Recording failed: ${errorMessage}`]
    );
  }

  /**
   * Fetch complete session details with participants.
   */
  async getSession(recordingId: string): Promise<VoiceRecordingSession | null> {
    const res = await this.pool.query(
      `SELECT * FROM recording_sessions WHERE id = $1`,
      [recordingId]
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];

    const participants = await this.getParticipants(recordingId);

    return {
      id: r.id,
      guildId: r.guild_id,
      voiceChannelId: r.voice_channel_id,
      startedBy: r.started_by,
      startedAt: r.started_at ? r.started_at.toISOString() : new Date().toISOString(),
      endedAt: r.ended_at ? r.ended_at.toISOString() : undefined,
      duration: Number(r.duration || 0),
      status: r.status,
      storageKey: r.storage_key,
      format: r.format,
      fileSizeBytes: Number(r.file_size_bytes || 0),
      transcriptionStatus: r.transcription_status,
      visibility: r.visibility,
      title: r.title,
      metadataStorageKey: r.metadata_storage_key,
      errorMessage: r.error_message,
      participants,
      createdAt: r.created_at ? r.created_at.toISOString() : new Date().toISOString(),
      updatedAt: r.updated_at ? r.updated_at.toISOString() : new Date().toISOString(),
    };
  }

  /**
   * Retrieve active recording in guild (if any).
   */
  async getActiveSession(guildId: string): Promise<VoiceRecordingSession | null> {
    const res = await this.pool.query(
      `SELECT id FROM recording_sessions
       WHERE guild_id = $1 AND status IN ('RECORDING', 'PROCESSING')
       ORDER BY started_at DESC
       LIMIT 1`,
      [guildId]
    );
    if (res.rows.length === 0) return null;
    return this.getSession(res.rows[0].id);
  }

  /**
   * List recording sessions with flexible filtering and pagination.
   */
  async listSessions(filters: RecordingFilterOptions = {}): Promise<VoiceRecordingSession[]> {
    const conditions: string[] = [];
    const params: any[] = [];

    if (filters.guildId) {
      params.push(filters.guildId);
      conditions.push(`guild_id = $${params.length}`);
    }

    if (filters.status) {
      params.push(filters.status);
      conditions.push(`status = $${params.length}`);
    } else {
      conditions.push(`status != 'DELETED'`);
    }

    if (filters.transcriptionStatus) {
      params.push(filters.transcriptionStatus);
      conditions.push(`transcription_status = $${params.length}`);
    }

    if (filters.visibility) {
      params.push(filters.visibility);
      conditions.push(`visibility = $${params.length}`);
    }

    if (filters.dateFrom) {
      params.push(filters.dateFrom);
      conditions.push(`started_at >= $${params.length}`);
    }

    if (filters.dateTo) {
      params.push(filters.dateTo);
      conditions.push(`started_at <= $${params.length}`);
    }

    if (filters.durationMin !== undefined) {
      params.push(filters.durationMin);
      conditions.push(`duration >= $${params.length}`);
    }

    if (filters.durationMax !== undefined) {
      params.push(filters.durationMax);
      conditions.push(`duration <= $${params.length}`);
    }

    if (filters.searchQuery) {
      params.push(`%${filters.searchQuery.trim()}%`);
      conditions.push(`(title ILIKE $${params.length})`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.max(1, Math.min(100, filters.limit || 20));
    const offset = Math.max(0, filters.offset || 0);

    params.push(limit);
    params.push(offset);

    const query = `
      SELECT id FROM recording_sessions
      ${whereClause}
      ORDER BY started_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;

    const res = await this.pool.query(query, params);
    const sessions: VoiceRecordingSession[] = [];

    for (const row of res.rows) {
      const s = await this.getSession(row.id);
      if (s) sessions.push(s);
    }

    return sessions;
  }

  /**
   * Delete recording session and all associated files, participants, and transcripts.
   */
  async deleteSession(recordingId: string, actorUserId: string = 'system'): Promise<boolean> {
    const session = await this.getSession(recordingId);
    if (!session) return false;

    // 1. Delete on-disk files
    const sessionDir = path.join(this.storageRoot, recordingId);
    const tmpDir = path.join(this.tmpRoot, recordingId);

    if (fs.existsSync(sessionDir)) {
      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        logger.info({ sessionDir }, '[RECORDING] Deleted session directory');
      } catch (err) {
        logger.error({ err, sessionDir }, 'Failed to delete session directory');
      }
    }

    if (fs.existsSync(tmpDir)) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    }

    // 2. Transactionally remove database records and log final audit
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Log audit before deleting
      await client.query(
        `INSERT INTO recording_audit_events (recording_id, actor_user_id, action, timestamp, details)
         VALUES ($1, $2, 'DELETED', NOW(), $3)`,
        [recordingId, actorUserId, `Recording session ${recordingId} permanently deleted`]
      );

      // Cascade deletion handles participants, transcripts, and segments
      await client.query(`DELETE FROM recording_sessions WHERE id = $1`, [recordingId]);

      await client.query('COMMIT');
      logger.info({ recordingId }, '[RECORDING] Successfully deleted recording session');
      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Retrieve participants for a recording.
   */
  private async getParticipants(recordingId: string): Promise<ParticipantRecordingMetadata[]> {
    const res = await this.pool.query(
      `SELECT * FROM recording_participants WHERE recording_id = $1 ORDER BY joined_at ASC`,
      [recordingId]
    );

    return res.rows.map((r) => ({
      id: r.id,
      recordingId: r.recording_id,
      userId: r.user_id,
      displayName: r.display_name,
      joinedAt: r.joined_at ? r.joined_at.toISOString() : new Date().toISOString(),
      leftAt: r.left_at ? r.left_at.toISOString() : undefined,
      firstAudioTimestamp: Number(r.first_audio_timestamp ?? 0),
      lastAudioTimestamp: Number(r.last_audio_timestamp ?? 0),
      audioStorageKey: r.audio_storage_key,
    }));
  }

  /**
   * Get audit log entries for a recording session.
   */
  async getAuditEvents(recordingId: string): Promise<RecordingAuditEvent[]> {
    const res = await this.pool.query(
      `SELECT * FROM recording_audit_events WHERE recording_id = $1 ORDER BY timestamp ASC`,
      [recordingId]
    );

    return res.rows.map((r) => ({
      id: r.id,
      recordingId: r.recording_id,
      actorUserId: r.actor_user_id,
      action: r.action,
      timestamp: r.timestamp.toISOString(),
      details: r.details,
    }));
  }

  /**
   * Automatic retention policy enforcement (Requirement 27).
   */
  async cleanupExpiredRecordings(retentionDays: number = 30): Promise<number> {
    if (retentionDays <= 0) return 0;

    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const res = await this.pool.query(
      `SELECT id FROM recording_sessions
       WHERE started_at < $1 AND status = 'COMPLETED'`,
      [cutoff]
    );

    let count = 0;
    for (const row of res.rows) {
      try {
        await this.deleteSession(row.id, 'retention-policy-worker');
        count++;
      } catch (err) {
        logger.error({ err, sessionId: row.id }, 'Failed to purge expired recording');
      }
    }

    if (count > 0) {
      logger.info({ count, retentionDays }, '[RECORDING] Cleaned up %d expired recordings', count);
    }
    return count;
  }

  /**
   * Cleanup orphan temporary files older than 1 hour (Requirement 12).
   */
  async cleanupOrphanTemporaryFiles(): Promise<void> {
    if (!fs.existsSync(this.tmpRoot)) return;

    try {
      const entries = fs.readdirSync(this.tmpRoot);
      const oneHourAgo = Date.now() - 3600 * 1000;

      for (const entry of entries) {
        const fullPath = path.join(this.tmpRoot, entry);
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs < oneHourAgo) {
          fs.rmSync(fullPath, { recursive: true, force: true });
          logger.debug({ fullPath }, '[RECORDING] Cleaned orphan temp directory');
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Error cleaning orphan temp files');
    }
  }

  async cleanOrphanedRecordings(): Promise<void> {
    await this.cleanupOrphanTemporaryFiles();
  }

  getStorageRoot(): string {
    return this.storageRoot;
  }

  getTmpRoot(): string {
    return this.tmpRoot;
  }

  getMixer(): RecordingMixer {
    return this.mixer;
  }
}
