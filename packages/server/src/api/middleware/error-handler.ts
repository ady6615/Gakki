import type { Request, Response, NextFunction } from 'express';
import { createLogger } from '@gakki/core';

const logger = createLogger('api-error');

interface HttpError extends Error {
  status?: number;
}

/**
 * Global Express error handling middleware.
 *
 * Catches unhandled errors from route handlers and returns a
 * structured JSON response. Includes stack traces in development only.
 *
 * Must be registered AFTER all routes (Express identifies error handlers
 * by their 4-parameter signature).
 */
export function errorHandler(
  err: HttpError,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  logger.error({ err }, 'Unhandled API error');

  const status = err.status ?? 500;

  res.status(status).json({
    error: {
      message: err.message || 'Internal server error',
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
    },
  });
}
