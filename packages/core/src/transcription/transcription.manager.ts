import type pg from 'pg';
import { createLogger } from '../utils/logger';
import type { TranscriptionProviderRegistry } from './transcription-provider.registry';
import type { RecordingTranscript, TranscriptSegment } from '../types/recording';

const logger = createLogger('transcription-manager');

export class TranscriptionManager {
  constructor(
    private readonly pool: pg.Pool,
    private readonly registry: TranscriptionProviderRegistry,
    private readonly options: {
      defaultProvider?: string;
      maxConcurrentJobs?: number;
    } = {}
  ) {}

  /**
   * Start an asynchronous transcription job for a completed recording session.
   * Does NOT block the caller.
   */
  async queueTranscription(recordingId: string, actorUserId: string = 'system'): Promise<void> {
    // 1. Mark status as QUEUED
    await this.pool.query(
      `UPDATE recording_sessions
       SET transcription_status = 'QUEUED', updated_at = NOW()
       WHERE id = $1`,
      [recordingId]
    );

    // 2. Insert audit event
    await this.pool.query(
      `INSERT INTO recording_audit_events (recording_id, actor_user_id, action, timestamp, details)
       VALUES ($1, $2, 'TRANSCRIPTION_REQUESTED', NOW(), 'Asynchronous transcription requested')`,
      [recordingId, actorUserId]
    );

    // 3. Kick off async task in background
    setImmediate(async () => {
      try {
        await this.processTranscription(recordingId);
      } catch (err: any) {
        logger.error({ err, recordingId }, '[TRANSCRIPTION] Async transcription failed');
        await this.pool.query(
          `UPDATE recording_sessions
           SET transcription_status = 'FAILED', error_message = $2, updated_at = NOW()
           WHERE id = $1`,
          [recordingId, err.message || 'Transcription failed']
        );
      }
    });
  }

  /**
   * Execute the transcription processing pipeline for a session.
   */
  async processTranscription(recordingId: string): Promise<RecordingTranscript | null> {
    logger.info({ recordingId }, '[TRANSCRIPTION] Starting transcription processing');

    // 1. Mark as PROCESSING
    await this.pool.query(
      `UPDATE recording_sessions
       SET transcription_status = 'PROCESSING', updated_at = NOW()
       WHERE id = $1`,
      [recordingId]
    );

    // 2. Fetch session and participants
    const sessionRes = await this.pool.query(
      `SELECT * FROM recording_sessions WHERE id = $1`,
      [recordingId]
    );
    if (sessionRes.rows.length === 0) {
      throw new Error(`Recording session ${recordingId} not found`);
    }
    const session = sessionRes.rows[0];

    const participantsRes = await this.pool.query(
      `SELECT user_id, display_name, first_audio_timestamp, audio_storage_key
       FROM recording_participants
       WHERE recording_id = $1
       ORDER BY joined_at ASC`,
      [recordingId]
    );

    const participants = participantsRes.rows.map((p) => ({
      userId: p.user_id,
      displayName: p.display_name,
      firstAudioMs: p.first_audio_timestamp || 0,
      audioFilePath: p.audio_storage_key,
    }));

    // 3. Resolve active transcription provider
    const provider = await this.registry.getBestAvailableProvider();
    logger.info(
      { recordingId, provider: provider.name },
      '[TRANSCRIPTION] Utilizing provider: %s',
      provider.name
    );

    // 4. Run transcription
    const result = await provider.transcribe(session.storage_key || '', {
      participants,
    });

    // 5. Transactionally save transcript and segments
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Delete any previous transcript for this recording
      await client.query(`DELETE FROM transcripts WHERE recording_id = $1`, [recordingId]);

      // Insert parent transcript
      const transcriptInsert = await client.query<{ id: string; created_at: Date; updated_at: Date }>(
        `INSERT INTO transcripts (recording_id, provider, model, language, text, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'COMPLETED', NOW(), NOW())
         RETURNING id, created_at, updated_at`,
        [recordingId, result.provider, result.model, result.language, result.fullText]
      );
      const transcriptId = transcriptInsert.rows[0].id;

      // Insert segments
      const savedSegments: TranscriptSegment[] = [];
      for (let i = 0; i < result.segments.length; i++) {
        const seg = result.segments[i];
        const segRes = await client.query<{ id: string }>(
          `INSERT INTO transcript_segments (
             transcript_id, recording_id, speaker_id, speaker_name,
             start_ms, end_ms, text, confidence, position
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id`,
          [
            transcriptId,
            recordingId,
            seg.speakerId || null,
            seg.speakerName,
            seg.startMs,
            seg.endMs,
            seg.text,
            seg.confidence,
            i,
          ]
        );

        savedSegments.push({
          id: segRes.rows[0].id,
          transcriptId,
          recordingId,
          speakerId: seg.speakerId || null,
          speakerName: seg.speakerName,
          startMs: seg.startMs,
          endMs: seg.endMs,
          text: seg.text,
          confidence: seg.confidence,
          position: i,
        });
      }

      // Mark session transcription_status as COMPLETED
      await client.query(
        `UPDATE recording_sessions
         SET transcription_status = 'COMPLETED', updated_at = NOW()
         WHERE id = $1`,
        [recordingId]
      );

      await client.query('COMMIT');

      logger.info(
        { recordingId, segmentCount: savedSegments.length },
        '[TRANSCRIPTION] Successfully completed and saved transcript'
      );

      return {
        id: transcriptId,
        recordingId,
        provider: result.provider,
        model: result.model,
        language: result.language,
        text: result.fullText,
        status: 'COMPLETED',
        segments: savedSegments,
        createdAt: transcriptInsert.rows[0].created_at.toISOString(),
        updatedAt: transcriptInsert.rows[0].updated_at.toISOString(),
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Retrieve transcript and segments for a recording session.
   */
  async getTranscript(recordingId: string): Promise<RecordingTranscript | null> {
    const tRes = await this.pool.query(
      `SELECT * FROM transcripts WHERE recording_id = $1`,
      [recordingId]
    );
    if (tRes.rows.length === 0) return null;
    const t = tRes.rows[0];

    const segRes = await this.pool.query(
      `SELECT * FROM transcript_segments
       WHERE transcript_id = $1
       ORDER BY position ASC`,
      [t.id]
    );

    const segments: TranscriptSegment[] = segRes.rows.map((s) => ({
      id: s.id,
      transcriptId: s.transcript_id,
      recordingId: s.recording_id,
      speakerId: s.speaker_id,
      speakerName: s.speaker_name,
      startMs: s.start_ms,
      endMs: s.end_ms,
      text: s.text,
      confidence: s.confidence,
      position: s.position,
    }));

    return {
      id: t.id,
      recordingId: t.recording_id,
      provider: t.provider,
      model: t.model,
      language: t.language,
      text: t.text,
      status: t.status,
      segments,
      createdAt: t.created_at ? t.created_at.toISOString() : new Date().toISOString(),
      updatedAt: t.updated_at ? t.updated_at.toISOString() : new Date().toISOString(),
    };
  }

  /**
   * Search within a recording's transcript segments by keyword/phrase.
   * Utilizes database indexing and ordering by timestamp.
   */
  async searchSegments(recordingId: string, query: string): Promise<TranscriptSegment[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];

    const res = await this.pool.query(
      `SELECT * FROM transcript_segments
       WHERE recording_id = $1 AND text ILIKE $2
       ORDER BY start_ms ASC
       LIMIT 50`,
      [recordingId, `%${trimmed}%`]
    );

    return res.rows.map((s) => ({
      id: s.id,
      transcriptId: s.transcript_id,
      recordingId: s.recording_id,
      speakerId: s.speaker_id,
      speakerName: s.speaker_name,
      startMs: s.start_ms,
      endMs: s.end_ms,
      text: s.text,
      confidence: s.confidence,
      position: s.position,
    }));
  }

  async searchTranscriptSegments(recordingId: string, query: string): Promise<TranscriptSegment[]> {
    return this.searchSegments(recordingId, query);
  }
}

