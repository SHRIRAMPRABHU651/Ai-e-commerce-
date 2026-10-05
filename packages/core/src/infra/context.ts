import type { AIService } from '@orvia/ai';
import type { AdsRegistry } from '@orvia/ads';
import type { AppConfig, Logger } from '@orvia/config';
import type { NotificationRouter } from '@orvia/notifications';
import type { PaymentRegistry } from '@orvia/payments';
import type { SupplierRegistry } from '@orvia/suppliers';
import type { Role } from '@orvia/types';
import type { JobQueue } from './queue';
import type { SettingsService } from './settings';

export interface Actor {
  id: string;
  type: 'user' | 'ai' | 'system' | 'webhook' | 'anonymous';
  role?: Role;
  requestId?: string;
}

export const SYSTEM: Actor = { id: 'system', type: 'system' };
export const aiActor = (agent: string): Actor => ({ id: agent, type: 'ai' });

/** Everything a domain function needs. Built once per process (API, worker, tests). */
export interface Ctx {
  cfg: AppConfig;
  log: Logger;
  ai: AIService;
  suppliers: SupplierRegistry;
  payments: PaymentRegistry;
  ads: AdsRegistry;
  notifier: NotificationRouter;
  queue: JobQueue;
  settings: SettingsService;
  now: () => Date;
}

export class DomainError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
export const notFound = (what: string) => new DomainError(`${what} not found`, 'NOT_FOUND', 404);
export const conflict = (msg: string, code = 'CONFLICT') => new DomainError(msg, code, 409);
export const forbidden = (msg = 'Forbidden') => new DomainError(msg, 'FORBIDDEN', 403);
