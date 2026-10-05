/**
 * Strict Voice Command Intent Schema & Whitelisted Function Declarations
 *
 * Implements Requirements 7, 8, 9, 10:
 * - Strict schema validation for all incoming voice intents.
 * - Whitelist of permitted music control function tools.
 * - Prohibits system/shell/file/SQL/arbitrary execution.
 * - Permission level mapping matching Discord/Web permissions.
 */

import { z } from 'zod';
import { CommandPermissionLevel } from '../types/permissions';
import type { VoiceIntent, VoiceIntentType } from '../types/voice-command';

/** Validated Voice Intent Zod Schema */
export const VoiceIntentSchema = z.object({
  intent: z.enum([
    'PLAY_TRACK',
    'PAUSE',
    'RESUME',
    'SKIP',
    'STOP',
    'SET_VOLUME',
    'SHUFFLE',
    'SMART_SHUFFLE',
    'ENABLE_DJ',
    'DISABLE_DJ',
    'NEXT',
    'SHOW_LYRICS',
    'SAVE_FAVORITE',
    'PLAY_PLAYLIST',
    'SET_LOOP',
    'CLARIFY_AMBIGUITY',
    'CONVERSATIONAL_QUERY',
    'UNKNOWN',
  ]),
  query: z.string().optional(),
  volume: z.number().min(0).max(100).optional(),
  playlistName: z.string().optional(),
  loopMode: z.enum(['off', 'track', 'queue']).optional(),
  confidence: z.number().min(0).max(1).default(1.0),
  rawTranscript: z.string().optional(),
  isConversational: z.boolean().default(false),
  conversationalResponse: z.string().optional(),
  clarificationNeeded: z.boolean().default(false),
  clarificationPrompt: z.string().optional(),
  candidateTracks: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        artist: z.string().nullable().optional(),
        duration: z.number().nullable().optional(),
      }),
    )
    .optional(),
});

/** Mapping of Voice Intents to Required Backend Permission Levels */
export const INTENT_PERMISSION_MAP: Record<VoiceIntentType, CommandPermissionLevel> = {
  PLAY_TRACK: CommandPermissionLevel.USER,
  PAUSE: CommandPermissionLevel.USER,
  RESUME: CommandPermissionLevel.USER,
  SKIP: CommandPermissionLevel.USER,
  NEXT: CommandPermissionLevel.USER,
  SET_VOLUME: CommandPermissionLevel.DJ,
  SHUFFLE: CommandPermissionLevel.DJ,
  SMART_SHUFFLE: CommandPermissionLevel.DJ,
  ENABLE_DJ: CommandPermissionLevel.DJ,
  DISABLE_DJ: CommandPermissionLevel.DJ,
  STOP: CommandPermissionLevel.DJ,
  SHOW_LYRICS: CommandPermissionLevel.USER,
  SAVE_FAVORITE: CommandPermissionLevel.USER,
  PLAY_PLAYLIST: CommandPermissionLevel.USER,
  SET_LOOP: CommandPermissionLevel.DJ,
  CLARIFY_AMBIGUITY: CommandPermissionLevel.USER,
  CONVERSATIONAL_QUERY: CommandPermissionLevel.USER,
  UNKNOWN: CommandPermissionLevel.USER,
};

/**
 * Whitelisted Function Tools for Gemini Live / Gemini Function Calling.
 * Strict definition matching Google GenAI SDK function declarations schema.
 */
export const WHITELISTED_VOICE_TOOLS = [
  {
    name: 'play_track',
    description: 'Search for a music track or song and play or queue it in Gakki.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: {
          type: 'STRING',
          description: 'The title, artist, or search query of the song to play.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'pause',
    description: 'Pause the currently playing music track.',
    parameters: {
      type: 'OBJECT',
      properties: {},
    },
  },
  {
    name: 'resume',
    description: 'Resume music playback if paused.',
    parameters: {
      type: 'OBJECT',
      properties: {},
    },
  },
  {
    name: 'skip',
    description: 'Skip the current track and play the next track in the queue.',
    parameters: {
      type: 'OBJECT',
      properties: {},
    },
  },
  {
    name: 'stop',
    description: 'Stop music playback and clear the active audio output.',
    parameters: {
      type: 'OBJECT',
      properties: {},
    },
  },
  {
    name: 'set_volume',
    description: 'Adjust the music playback volume level from 0 to 100 percent.',
    parameters: {
      type: 'OBJECT',
      properties: {
        value: {
          type: 'INTEGER',
          description: 'Volume level from 0 to 100.',
        },
      },
      required: ['value'],
    },
  },
  {
    name: 'smart_shuffle',
    description: 'Perform an AI-powered smart shuffle on the current queue based on acoustic energy & harmonic key.',
    parameters: {
      type: 'OBJECT',
      properties: {},
    },
  },
  {
    name: 'enable_dj',
    description: 'Enable the AI Dynamic DJ to automatically curate and mix seamless tracks.',
    parameters: {
      type: 'OBJECT',
      properties: {},
    },
  },
  {
    name: 'disable_dj',
    description: 'Disable the AI Dynamic DJ mode.',
    parameters: {
      type: 'OBJECT',
      properties: {},
    },
  },
  {
    name: 'play_playlist',
    description: 'Load and play a specific saved user or system playlist.',
    parameters: {
      type: 'OBJECT',
      properties: {
        name: {
          type: 'STRING',
          description: 'The name of the playlist to play.',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'show_lyrics',
    description: 'Fetch and display synchronized lyrics for the currently playing track.',
    parameters: {
      type: 'OBJECT',
      properties: {},
    },
  },
  {
    name: 'favorite_current_track',
    description: 'Add the currently playing track to the user favorites library.',
    parameters: {
      type: 'OBJECT',
      properties: {},
    },
  },
  {
    name: 'set_loop',
    description: 'Set repeat/loop mode (off, track, queue).',
    parameters: {
      type: 'OBJECT',
      properties: {
        mode: {
          type: 'STRING',
          enum: ['off', 'track', 'queue'],
          description: 'Repeat mode: "off", "track", or "queue".',
        },
      },
      required: ['mode'],
    },
  },
];

/** List of strictly prohibited function names for security auditing */
export const PROHIBITED_FUNCTION_NAMES = new Set([
  'execute_shell',
  'exec',
  'shell',
  'read_file',
  'write_file',
  'delete_file',
  'run_sql',
  'query_db',
  'arbitrary_url',
  'fetch_url',
  'filesystem_access',
  'eval',
  'spawn',
]);

/**
 * Validates a structured voice intent against permissions and strict schema.
 */
export function validateVoiceIntent(
  rawIntent: unknown,
  userPermissionLevel: CommandPermissionLevel = CommandPermissionLevel.USER,
): { valid: boolean; intent?: VoiceIntent; error?: string } {
  const parsed = VoiceIntentSchema.safeParse(rawIntent);
  if (!parsed.success) {
    return {
      valid: false,
      error: `Invalid intent schema: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
    };
  }

  const intent = parsed.data as VoiceIntent;
  const requiredLevel = INTENT_PERMISSION_MAP[intent.intent] ?? CommandPermissionLevel.USER;

  if (userPermissionLevel < requiredLevel) {
    return {
      valid: false,
      intent,
      error: `Permission denied: Command ${intent.intent} requires permission level ${CommandPermissionLevel[requiredLevel]}, but user has ${CommandPermissionLevel[userPermissionLevel]}.`,
    };
  }

  return {
    valid: true,
    intent,
  };
}
