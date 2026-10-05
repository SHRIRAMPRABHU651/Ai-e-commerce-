import pino from 'pino';
import type { Logger } from 'pino';

export type { Logger };

const REDACT = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.apiKey',
  '*.secret',
  '*.clientSecret',
  '*.accessToken',
];

/** Structured JSON logger. `channel` distinguishes app / ai / supplier / payment / order / ad / security logs. */
export function createLogger(opts: { level?: string; service: string; destination?: pino.DestinationStream }): Logger {
  return pino(
    {
      level: opts.level ?? 'info',
      base: { service: opts.service },
      redact: { paths: REDACT, censor: '[redacted]' },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
    },
    opts.destination,
  );
}

export type Channel = 'app' | 'error' | 'ai' | 'supplier' | 'payment' | 'order' | 'ad' | 'security' | 'queue';
export const channelLog = (l: Logger, channel: Channel): Logger => l.child({ channel });
