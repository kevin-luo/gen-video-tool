import fs from 'node:fs';
import path from 'node:path';

type DiagnosticValue = string | number | boolean | null;
type DiagnosticDetails = Record<string, DiagnosticValue>;
type DiagnosticLevel = 'info' | 'warn' | 'error';

const MAX_LOG_BYTES = 1_048_576;

const sanitizeText = (value: string, limit = 1_000): string => value
  .replace(/Bearer\s+[^\s]+/giu, 'Bearer [redacted]')
  .replace(/\b(token|api[_-]?key|password|secret)=([^\s&]+)/giu, '$1=[redacted]')
  .replace(/\?[^\s]+/gu, '?[redacted]')
  .slice(0, limit);

export const diagnosticError = (value: unknown): DiagnosticDetails => {
  if (!(value instanceof Error)) return {name: 'UnknownError'};
  return {
    name: sanitizeText(value.name, 120),
    message: sanitizeText(value.message),
    stack: sanitizeText(value.stack?.split('\n').slice(0, 6).join('\n') ?? '', 2_000),
  };
};

export type DesktopDiagnostics = {
  logPath: string;
  info: (event: string, details?: DiagnosticDetails) => void;
  warn: (event: string, details?: DiagnosticDetails) => void;
  error: (event: string, details?: DiagnosticDetails) => void;
};

export const createDesktopDiagnostics = (userDataRoot: string): DesktopDiagnostics => {
  const directory = path.join(userDataRoot, 'logs');
  const logPath = path.join(directory, 'desktop.log');
  const previousLogPath = path.join(directory, 'desktop.previous.log');

  const write = (level: DiagnosticLevel, event: string, details: DiagnosticDetails = {}): void => {
    try {
      fs.mkdirSync(directory, {recursive: true});
      try {
        if (fs.statSync(logPath).size >= MAX_LOG_BYTES) {
          fs.rmSync(previousLogPath, {force: true});
          fs.renameSync(logPath, previousLogPath);
        }
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      fs.appendFileSync(logPath, `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        event: sanitizeText(event, 120),
        ...details,
      })}\n`, 'utf8');
    } catch {
      // Diagnostics must never become a new startup failure.
    }
  };

  return {
    logPath,
    info: (event, details) => write('info', event, details),
    warn: (event, details) => write('warn', event, details),
    error: (event, details) => write('error', event, details),
  };
};
