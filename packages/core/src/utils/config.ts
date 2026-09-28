import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';

/**
 * Find and load the .env file by walking up from the current directory.
 * This handles npm workspaces where CWD may be a nested package directory.
 */
function loadEnvFile(): void {
  // Try CWD first (most common case)
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    // Walk up from this file's location to find monorepo root
    path.resolve(__dirname, '..', '..', '..', '..', '.env'), // packages/core/src/utils -> root
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      dotenv.config({ path: candidate });
      return;
    }
  }

  // Fall back to default behavior
  dotenv.config();
}

/**
 * Configuration schema with runtime validation via Zod.
 *
 * Every environment variable the application needs is declared here.
 * Missing or malformed values produce a clear, actionable error at startup
 * rather than cryptic failures later.
 *
 * DISCORD_TOKEN and DISCORD_CLIENT_ID are optional so the server
 * can start (for API/web development) without a Discord bot token.
 */
const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Database
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // Discord (optional — server degrades gracefully without these)
  // dotenv sets empty values as "", so we transform "" -> undefined for .optional() to work
  DISCORD_TOKEN: z.string().optional().transform((v) => v || undefined),
  DISCORD_CLIENT_ID: z.string().optional().transform((v) => v || undefined),

  // API Server
  API_PORT: z.coerce.number().int().positive().default(3000),

  // Voice Lifecycle
  VOICE_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().nonnegative().default(300),

  // Phase 7: Audio Analysis & Recommendations
  AUDIO_ANALYZER_URL: z.string().default('http://127.0.0.1:5050'),
  RECOMMENDATION_RECENT_TRACK_COOLDOWN: z.coerce.number().int().nonnegative().default(10),

  // Logging
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
});

export type AppConfig = z.infer<typeof configSchema>;

let cachedConfig: AppConfig | null = null;

/**
 * Load and validate application configuration from environment variables.
 *
 * Throws a descriptive error listing every validation failure if any
 * required variable is missing or invalid. Result is cached after
 * the first successful call.
 */
export function loadConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;

  // Load .env file before validating
  loadEnvFile();

  const result = configSchema.safeParse(process.env);

  if (!result.success) {
    const formatted = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${formatted}`);
  }

  cachedConfig = result.data;
  return cachedConfig;
}
