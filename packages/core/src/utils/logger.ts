import pino from 'pino';

/**
 * Create a structured logger instance.
 *
 * Uses pino for high-performance JSON logging in production
 * and pino-pretty for human-readable output in development.
 *
 * @param name - Logger name, appears in every log line for filtering
 * @param level - Log level override (defaults to LOG_LEVEL env var or 'info')
 */
export function createLogger(name: string, level?: string): pino.Logger {
  const logLevel = level ?? process.env.LOG_LEVEL ?? 'info';
  const isDev = process.env.NODE_ENV !== 'production';

  return pino({
    name,
    level: logLevel,
    ...(isDev && {
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname',
        },
      },
    }),
  });
}
