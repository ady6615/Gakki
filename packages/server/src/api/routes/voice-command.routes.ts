/**
 * Voice Command, DJ Commentary & Google Meet API Routes
 *
 * Exposes REST endpoints for:
 * - Voice command state & simulated command execution
 * - AI DJ Commentary configuration & preview generation
 * - Google Meet OAuth, status, participant reflection & recording linkage
 */

import { Router, type Request, type Response } from 'express';
import {
  type VoiceCommandEngine,
  type DJCommentaryEngine,
  type VoiceSessionManager,
  CommandPermissionLevel,
} from '@gakki/core';
import type { MeetVoiceAdapter } from '../../meet/meet-voice.adapter';
import type { GeminiLiveVoiceProvider } from '../../voice/gemini-live-voice.provider';
import type { VoiceRateLimiter } from '../../security/voice-rate-limiter';

export function createVoiceCommandRouter(
  voiceCommandEngine: VoiceCommandEngine,
  djCommentaryEngine: DJCommentaryEngine,
  voiceSessionManager: VoiceSessionManager,
  meetAdapter?: MeetVoiceAdapter,
  geminiProvider?: GeminiLiveVoiceProvider,
  rateLimiter?: VoiceRateLimiter,
): Router {
  const router = Router();

  // ── Voice Commands State & Control ──────────────────────────────
  router.get('/state', (_req: Request, res: Response) => {
    const state = voiceCommandEngine.getState();
    res.json({
      success: true,
      state: {
        ...state,
        vadSensitivity: 0.025,
        wakeWord: 'Hey Gakki',
      },
    });
  });

  router.post('/state', async (req: Request, res: Response) => {
    try {
      const { enabled } = req.body;
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled must be a boolean' });
      }

      await voiceCommandEngine.setEnabled(enabled);
      res.json({ success: true, state: voiceCommandEngine.getState() });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to update voice command state' });
    }
  });

  router.post('/command', async (req: Request, res: Response) => {
    try {
      const { transcript, guildId, userId = 'user_web', permissionLevel = CommandPermissionLevel.USER } = req.body;
      if (!transcript || typeof transcript !== 'string') {
        return res.status(400).json({ error: 'transcript is required' });
      }

      // Rate limit check
      if (rateLimiter) {
        const rateCheck = rateLimiter.canExecuteCommand(userId);
        if (!rateCheck.allowed) {
          return res.status(429).json({
            error: 'Voice command rate limit exceeded',
            retryAfterMs: rateCheck.retryAfterMs,
          });
        }
      }

      const context = voiceSessionManager.createCommandContext({
        guildId,
        userId,
        permissionLevel,
      });

      const result = await voiceCommandEngine.executeVoiceCommand(transcript, context);
      res.json({ success: true, result });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Voice command execution failed' });
    }
  });

  // ── AI DJ Commentary Endpoints ─────────────────────────────────
  router.get('/dj-commentary', (_req: Request, res: Response) => {
    const config = djCommentaryEngine.getConfig();
    res.json({
      success: true,
      config,
      voices: ['Aoede', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Gakki-Local-Default'],
    });
  });

  router.post('/dj-commentary/config', (req: Request, res: Response) => {
    try {
      const updates = req.body;
      djCommentaryEngine.updateConfig(updates);
      res.json({ success: true, config: djCommentaryEngine.getConfig() });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to update DJ config' });
    }
  });

  router.post('/dj-commentary/preview', async (req: Request, res: Response) => {
    try {
      const { guildId = 'desktop-local', text, trigger = 'DJ_START', toTrack } = req.body;

      if (rateLimiter) {
        const rateCheck = rateLimiter.canGenerateTTS(guildId);
        if (!rateCheck.allowed) {
          return res.status(429).json({ error: 'DJ Commentary TTS rate limit exceeded' });
        }
      }

      const commentary = await djCommentaryEngine.pregenerateCommentary({
        guildId,
        trigger,
        toTrack: toTrack || {
          id: 'preview-track',
          title: 'After Dark',
          artist: 'Mr. Kitty',
          genre: 'Synthwave',
          bpm: 124,
          energy: 0.85,
        },
      });

      res.json({
        success: true,
        commentary: commentary
          ? {
              id: commentary.id,
              text: commentary.text,
              durationSeconds: commentary.durationSeconds,
              voiceProfile: commentary.voiceProfile,
              hasAudio: Boolean(commentary.audioBuffer && commentary.audioBuffer.length > 0),
            }
          : null,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to generate preview commentary' });
    }
  });

  // ── Google Meet Integration Endpoints ──────────────────────────
  router.get('/meet/status', (_req: Request, res: Response) => {
    if (!meetAdapter) {
      return res.json({
        success: true,
        configured: false,
        status: 'Meet adapter not mounted',
        capabilities: { receiveAudio: false, receiveVideo: false, receiveParticipants: false, sendAudio: false },
      });
    }

    const oauthStatus = meetAdapter.getOAuthService().getEligibilityStatus();
    const state = meetAdapter.getState();
    const capabilities = meetAdapter.getCapabilities();

    res.json({
      success: true,
      configured: oauthStatus.isConfigured,
      eligibility: oauthStatus,
      state,
      capabilities,
      virtualAudioWorkaround: {
        supported: true,
        method: 'Desktop Virtual Audio Output -> Google Meet Mic',
        instructions:
          'In Gakki settings, set Playback Target to "Virtual Audio Output". In Google Meet microphone settings, select "CABLE Output (VB-Audio Virtual Cable)".',
      },
    });
  });

  router.get('/meet/oauth/url', (_req: Request, res: Response) => {
    if (!meetAdapter) {
      return res.status(400).json({ error: 'Meet adapter not available' });
    }
    try {
      const url = meetAdapter.getOAuthService().getAuthorizationUrl();
      res.json({ success: true, url });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/meet/connect', async (req: Request, res: Response) => {
    if (!meetAdapter) {
      return res.status(400).json({ error: 'Meet adapter not available' });
    }
    try {
      const { spaceId, meetingUri } = req.body;
      if (!spaceId) {
        return res.status(400).json({ error: 'spaceId is required (e.g. abc-defg-hij)' });
      }

      await meetAdapter.joinVoice(spaceId, undefined, { meetingUri });
      res.json({ success: true, state: meetAdapter.getState() });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to connect to Meet conference' });
    }
  });

  router.post('/meet/disconnect', async (_req: Request, res: Response) => {
    if (!meetAdapter) {
      return res.status(400).json({ error: 'Meet adapter not available' });
    }
    try {
      await meetAdapter.leaveVoice();
      res.json({ success: true, state: meetAdapter.getState() });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to disconnect from Meet conference' });
    }
  });

  router.get('/meet/participants', (_req: Request, res: Response) => {
    if (!meetAdapter) {
      return res.json({ success: true, participants: [] });
    }
    const participants = meetAdapter.getParticipants();
    res.json({ success: true, participants });
  });

  router.post('/meet/record/start', async (req: Request, res: Response) => {
    if (!meetAdapter) {
      return res.status(400).json({ error: 'Meet adapter not available' });
    }
    try {
      const { startedBy = 'user_web', title } = req.body;
      const recordingId = await meetAdapter.startConferenceRecording(startedBy, title);
      res.json({ success: true, recordingId });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to start Meet recording' });
    }
  });

  return router;
}
