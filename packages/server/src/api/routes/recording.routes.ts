import { Router, type Request, type Response } from 'express';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RecordingManager, TranscriptionManager } from '@gakki/core';
import type { VoiceReceiverManager } from '../../voice/voice-receiver';
import { createLogger } from '@gakki/core';

const logger = createLogger('recording-routes');

export function recordingRoutes(
  recordingManager?: RecordingManager,
  transcriptionManager?: TranscriptionManager,
  voiceReceiver?: VoiceReceiverManager
): Router {
  const router = Router();

  if (!recordingManager) {
    router.use((_req, res) => {
      res.status(503).json({ error: 'Recording subsystem not initialized' });
    });
    return router;
  }

  /**
   * GET /api/recordings
   * List recording sessions with filtering (Requirement 24).
   */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const guildIdQuery = req.query.guildId as string | undefined;
      const guildId = guildIdQuery && guildIdQuery !== 'web-dashboard' ? guildIdQuery : undefined;
      const status = req.query.status as any;
      const transcriptionStatus = req.query.transcriptionStatus as any;
      const visibility = req.query.visibility as any;
      const searchQuery = (req.query.q as string) || (req.query.search as string);
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
      const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;

      const sessions = await recordingManager.listSessions({
        guildId,
        status,
        transcriptionStatus,
        visibility,
        searchQuery,
        limit,
        offset,
      });

      return res.json({ recordings: sessions });
    } catch (err: any) {
      logger.error({ err }, 'Failed to list recordings');
      return res.status(500).json({ error: 'Failed to retrieve recording sessions' });
    }
  });

  /**
   * GET /api/recordings/active/:guildId
   * GET /api/recordings/guild/:guildId/active
   * GET /api/recordings/active
   * Get active recording status in guild. (Placed before /:id so 'active' is not treated as an ID)
   */
  router.get(['/active/:guildId', '/guild/:guildId/active', '/active'], async (req: Request, res: Response) => {
    try {
      let guildId = req.params.guildId || (req.query.guildId as string | undefined);
      if (!guildId || guildId === 'web-dashboard') {
        const client = voiceReceiver?.getVoiceAdapter()?.getClient();
        if (client) {
          for (const [gid, guild] of client.guilds.cache) {
            if (voiceReceiver?.isRecording(gid) || guild.members?.me?.voice?.channelId) {
              guildId = gid;
              break;
            }
          }
        }
      }

      let active = null;
      if (guildId && guildId !== 'web-dashboard') {
        if (voiceReceiver) {
          active = await voiceReceiver.getActiveRecording(guildId);
        } else {
          active = await recordingManager.getActiveSession(guildId);
        }
      }

      return res.json({ activeRecording: active, activeSession: active });
    } catch (err: any) {
      logger.error({ err }, 'Failed to check active recording');
      return res.status(500).json({ error: 'Failed to check active recording' });
    }
  });

  /**
   * POST /api/recordings/start
   * POST /api/recordings/guild/:guildId/start
   * Start recording from Web UI or API.
   */
  router.post(['/start', '/guild/:guildId/start'], async (req: Request, res: Response) => {
    if (!voiceReceiver) {
      return res.status(503).json({ error: 'Voice receiver service not initialized' });
    }

    try {
      let guildId = req.params.guildId || req.body.guildId;
      if (!guildId || guildId === 'web-dashboard') {
        // Auto-discover the active Discord guild where the bot is currently in a voice channel
        const client = voiceReceiver.getVoiceAdapter()?.getClient();
        if (client) {
          for (const [gid, guild] of client.guilds.cache) {
            if (guild.members?.me?.voice?.channelId) {
              guildId = gid;
              break;
            }
          }
        }
      }

      if (!guildId || guildId === 'web-dashboard') {
        return res.status(400).json({
          error: 'Please connect the bot to a Discord voice channel first (or provide guildId and channelId).',
        });
      }

      const { channelId, startedBy, title, visibility } = req.body;
      const session = await voiceReceiver.startRecording(guildId, {
        channelId,
        startedBy: startedBy || 'Web Dashboard Operator',
        title,
        visibility,
      });

      return res.json({ success: true, recording: session, session });
    } catch (err: any) {
      logger.error({ err }, 'Web start recording failed');
      return res.status(400).json({ error: err.message || 'Failed to start recording' });
    }
  });

  /**
   * POST /api/recordings/stop
   * POST /api/recordings/guild/:guildId/stop
   * Stop recording from Web UI or API.
   */
  router.post(['/stop', '/guild/:guildId/stop'], async (req: Request, res: Response) => {
    if (!voiceReceiver) {
      return res.status(503).json({ error: 'Voice receiver service not initialized' });
    }

    try {
      let guildId = req.params.guildId || req.body.guildId;
      if (!guildId || guildId === 'web-dashboard') {
        const client = voiceReceiver.getVoiceAdapter()?.getClient();
        if (client) {
          for (const [gid] of client.guilds.cache) {
            if (voiceReceiver.isRecording(gid)) {
              guildId = gid;
              break;
            }
          }
        }
      }

      if (!guildId || guildId === 'web-dashboard') {
        return res.status(400).json({ error: 'guildId is required to stop recording' });
      }

      const actorUserId = req.body.userId || req.body.actorUserId || 'Web Dashboard Operator';
      const result = await voiceReceiver.stopRecording(guildId, actorUserId);
      return res.json({ success: true, result });
    } catch (err: any) {
      logger.error({ err }, 'Web stop recording failed');
      return res.status(400).json({ error: err.message || 'Failed to stop recording' });
    }
  });

  /**
   * GET /api/recordings/:id
   * Get single recording details with participants.
   */
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const session = await recordingManager.getSession(id);
      if (!session) {
        return res.status(404).json({ error: 'Recording session not found' });
      }

      let transcript = null;
      if (transcriptionManager) {
        transcript = await transcriptionManager.getTranscript(id);
      }

      return res.json({ recording: session, transcript });
    } catch (err: any) {
      logger.error({ err }, 'Failed to get recording');
      return res.status(500).json({ error: 'Failed to retrieve recording' });
    }
  });

  /**
   * GET /api/recordings/:id/audio
   * GET /api/recordings/:id/stream
   * Stream audio with HTTP 206 Partial Content range support for browser seeking (Requirement 22).
   */
  router.get(['/:id/audio', '/:id/stream'], async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const session = await recordingManager.getSession(id);
      if (!session || !session.storageKey || !fs.existsSync(session.storageKey)) {
        return res.status(404).json({ error: 'Recording audio file not found' });
      }

      // Security check: Prevent path traversal
      const resolved = path.resolve(session.storageKey);
      if (!resolved.startsWith(path.resolve(recordingManager.getStorageRoot()))) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const stat = fs.statSync(resolved);
      const fileSize = stat.size;
      const range = req.headers.range;

      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = end - start + 1;
        const fileStream = fs.createReadStream(resolved, { start, end });

        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': 'audio/wav',
        });
        fileStream.pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Length': fileSize,
          'Content-Type': 'audio/wav',
          'Accept-Ranges': 'bytes',
        });
        fs.createReadStream(resolved).pipe(res);
      }
    } catch (err: any) {
      logger.error({ err }, 'Failed to stream recording audio');
      return res.status(500).json({ error: 'Failed to stream audio' });
    }
  });

  /**
   * GET /api/recordings/:id/download
   * Safe download of mixed audio file, transcript, or metadata (Requirement 25).
   */
  router.get('/:id/download', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const downloadType = (req.query.type as string)?.toLowerCase();

      // Handle transcript download requested via ?type=transcript
      if (downloadType === 'transcript') {
        if (!transcriptionManager) {
          return res.status(503).json({ error: 'Transcription service not configured' });
        }
        const transcript = await transcriptionManager.getTranscript(id);
        if (!transcript) {
          return res.status(404).json({ error: 'Transcript not found for this recording' });
        }
        const formattedLines = (transcript.segments || []).map((s) => {
          const mm = Math.floor(s.startMs / 60000).toString().padStart(2, '0');
          const ss = Math.floor((s.startMs % 60000) / 1000).toString().padStart(2, '0');
          return `[${mm}:${ss}] ${s.speakerName || 'Speaker'}:\n${s.text}\n`;
        });
        res.setHeader('Content-Disposition', `attachment; filename="transcript-${id.slice(0, 8)}.txt"`);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.send(formattedLines.join('\n'));
      }

      // Handle metadata download requested via ?type=metadata
      if (downloadType === 'metadata') {
        const session = await recordingManager.getSession(id);
        if (!session || !session.metadataStorageKey || !fs.existsSync(session.metadataStorageKey)) {
          return res.status(404).json({ error: 'Metadata file not found' });
        }
        res.setHeader('Content-Disposition', `attachment; filename="metadata-${id.slice(0, 8)}.json"`);
        res.setHeader('Content-Type', 'application/json');
        return fs.createReadStream(session.metadataStorageKey).pipe(res);
      }

      // Default: Audio file download
      const session = await recordingManager.getSession(id);
      if (!session || !session.storageKey || !fs.existsSync(session.storageKey)) {
        return res.status(404).json({ error: 'Recording audio file not found' });
      }

      const filename = `recording-${id.slice(0, 8)}.wav`;
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Type', 'audio/wav');

      const fileStream = fs.createReadStream(session.storageKey);
      fileStream.pipe(res);
    } catch (err: any) {
      logger.error({ err }, 'Download failed');
      return res.status(500).json({ error: 'Download failed' });
    }
  });

  /**
   * GET /api/recordings/:id/download/transcript
   * Download transcript as .txt or .json.
   */
  router.get('/:id/download/transcript', async (req: Request, res: Response) => {
    if (!transcriptionManager) {
      return res.status(503).json({ error: 'Transcription service not configured' });
    }

    try {
      const { id } = req.params;
      const transcript = await transcriptionManager.getTranscript(id);
      if (!transcript) {
        return res.status(404).json({ error: 'Transcript not found for this recording' });
      }

      const format = (req.query.format as string) || 'txt';
      if (format === 'json') {
        res.setHeader('Content-Disposition', `attachment; filename="transcript-${id.slice(0, 8)}.json"`);
        res.setHeader('Content-Type', 'application/json');
        return res.send(JSON.stringify(transcript, null, 2));
      }

      // Plain text format with timestamps and speakers
      const formattedLines = (transcript.segments || []).map((s) => {
        const mm = Math.floor(s.startMs / 60000).toString().padStart(2, '0');
        const ss = Math.floor((s.startMs % 60000) / 1000).toString().padStart(2, '0');
        return `[${mm}:${ss}] ${s.speakerName || 'Speaker'}:\n${s.text}\n`;
      });

      res.setHeader('Content-Disposition', `attachment; filename="transcript-${id.slice(0, 8)}.txt"`);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.send(formattedLines.join('\n'));
    } catch (err: any) {
      logger.error({ err }, 'Transcript download failed');
      return res.status(500).json({ error: 'Failed to download transcript' });
    }
  });

  /**
   * GET /api/recordings/:id/download/metadata
   * Download metadata.json (Requirement 25).
   */
  router.get('/:id/download/metadata', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const session = await recordingManager.getSession(id);
      if (!session || !session.metadataStorageKey || !fs.existsSync(session.metadataStorageKey)) {
        return res.status(404).json({ error: 'Metadata file not found' });
      }

      res.setHeader('Content-Disposition', `attachment; filename="metadata-${id.slice(0, 8)}.json"`);
      res.setHeader('Content-Type', 'application/json');
      fs.createReadStream(session.metadataStorageKey).pipe(res);
    } catch (err: any) {
      logger.error({ err }, 'Metadata download failed');
      return res.status(500).json({ error: 'Failed to download metadata' });
    }
  });

  /**
   * GET /api/recordings/:id/transcript
   * Get transcript with all timestamped segments (Requirement 20).
   */
  router.get('/:id/transcript', async (req: Request, res: Response) => {
    if (!transcriptionManager) {
      return res.status(503).json({ error: 'Transcription service not configured' });
    }

    try {
      const { id } = req.params;
      const transcript = await transcriptionManager.getTranscript(id);
      if (!transcript) {
        return res.status(404).json({ error: 'Transcript not found' });
      }
      return res.json(transcript);
    } catch (err: any) {
      logger.error({ err }, 'Failed to fetch transcript');
      return res.status(500).json({ error: 'Failed to fetch transcript' });
    }
  });

  /**
   * GET /api/recordings/:id/transcript/search?q=...
   * Fast keyword search within transcript segments (Requirement 23).
   */
  router.get('/:id/transcript/search', async (req: Request, res: Response) => {
    if (!transcriptionManager) {
      return res.status(503).json({ error: 'Transcription service not configured' });
    }

    try {
      const { id } = req.params;
      const q = (req.query.q as string) || '';
      const segments = await transcriptionManager.searchSegments(id, q);
      return res.json({ query: q, results: segments });
    } catch (err: any) {
      logger.error({ err }, 'Transcript search failed');
      return res.status(500).json({ error: 'Transcript search failed' });
    }
  });

  /**
   * POST /api/recordings/:id/transcribe
   * Trigger / re-trigger asynchronous transcription (Requirement 16).
   */
  router.post('/:id/transcribe', async (req: Request, res: Response) => {
    if (!transcriptionManager) {
      return res.status(503).json({ error: 'Transcription service not configured' });
    }

    try {
      const { id } = req.params;
      const session = await recordingManager.getSession(id);
      if (!session) {
        return res.status(404).json({ error: 'Recording session not found' });
      }

      await transcriptionManager.queueTranscription(id, (req.body.userId as string) || 'api-user');
      return res.json({
        message: 'Transcription processing started',
        recordingId: id,
        status: 'QUEUED',
      });
    } catch (err: any) {
      logger.error({ err }, 'Failed to queue transcription');
      return res.status(500).json({ error: 'Failed to queue transcription' });
    }
  });

  /**
   * DELETE /api/recordings/:id
   * Permanently delete recording session, files, and transcript (Requirement 26).
   */
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const actorUserId = (req.body.userId as string) || 'api-user';
      const success = await recordingManager.deleteSession(id, actorUserId);
      if (!success) {
        return res.status(404).json({ error: 'Recording session not found' });
      }
      return res.json({ success: true, message: 'Recording deleted successfully' });
    } catch (err: any) {
      logger.error({ err }, 'Failed to delete recording');
      return res.status(500).json({ error: 'Failed to delete recording' });
    }
  });

  return router;
}
