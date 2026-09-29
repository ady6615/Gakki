import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Desktop-Safe Logger.
 * Writes sanitized, non-secret logs to disk in a user-accessible directory
 * and outputs formatted logs to stdout.
 *
 * Implements Requirement 31.
 */
export class DesktopLogger {
  private logDir: string;
  private logFilePath: string;

  constructor() {
    const appData = process.env.APPDATA || (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : path.join(os.homedir(), '.config'));

    this.logDir = path.join(appData, 'Gakki', 'logs');
    this.logFilePath = path.join(this.logDir, 'desktop.log');

    try {
      fs.mkdirSync(this.logDir, { recursive: true });
    } catch {
      // ignore
    }
  }

  public getLogPath(): string {
    return this.logFilePath;
  }

  public getLogDir(): string {
    return this.logDir;
  }

  public log(tag: string, message: string, meta?: any): void {
    const timestamp = new Date().toISOString();
    const sanitizedMeta = meta ? this.sanitize(meta) : '';
    const formattedLine = `[${timestamp}] [${tag.toUpperCase()}] ${message} ${sanitizedMeta}`.trim();

    console.log(formattedLine);

    try {
      fs.appendFileSync(this.logFilePath, formattedLine + '\n', 'utf-8');
    } catch {
      // Ignore write errors
    }
  }

  public info(tag: string, message: string, meta?: any): void {
    this.log(tag, message, meta);
  }

  public warn(tag: string, message: string, meta?: any): void {
    this.log(tag, `WARN: ${message}`, meta);
  }

  public error(tag: string, message: string, meta?: any): void {
    this.log(tag, `ERROR: ${message}`, meta);
  }

  private sanitize(obj: any): string {
    try {
      const copy = JSON.parse(JSON.stringify(obj));
      const forbidden = ['token', 'secret', 'password', 'key', 'auth', 'database_url'];
      const sanitizeObj = (target: any) => {
        if (!target || typeof target !== 'object') return;
        for (const k of Object.keys(target)) {
          if (forbidden.some((f) => k.toLowerCase().includes(f))) {
            target[k] = '[REDACTED]';
          } else if (typeof target[k] === 'object') {
            sanitizeObj(target[k]);
          }
        }
      };
      sanitizeObj(copy);
      return JSON.stringify(copy);
    } catch {
      return '';
    }
  }
}

export const desktopLogger = new DesktopLogger();
