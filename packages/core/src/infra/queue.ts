import { hostname } from 'node:os';
import { backoffDelay, metrics, sleep } from '@orvia/config';
import type { Logger } from '@orvia/config';
import { Job, SystemSetting } from '@orvia/database';

export class NonRetryableError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'NonRetryableError';
  }
}

export interface EnqueueOptions {
  queue?: string;
  delayMs?: number;
  /** While a job with this key is queued or active, enqueueing again is a no-op (returns the existing job id). */
  dedupeKey?: string;
  maxAttempts?: number;
}

export interface JobRecord {
  _id: unknown;
  name: string;
  queue: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
}

export type JobHandler = (payload: never, job: JobRecord) => Promise<unknown>;

/**
 * Durable job queue on MongoDB: at-least-once delivery, visibility-timeout locks, exponential backoff,
 * de-duplication and a dead-letter state. Handlers must therefore be idempotent (all of ours are).
 */
export class JobQueue {
  private handlers = new Map<string, JobHandler>();
  private running = false;
  private loops: Promise<void>[] = [];
  readonly workerId = `${hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 7)}`;
  onDead?: (job: JobRecord, err: Error) => Promise<void> | void;

  constructor(private readonly log: Logger) {}

  register<P>(name: string, handler: (payload: P, job: JobRecord) => Promise<unknown>): void {
    this.handlers.set(name, handler as unknown as JobHandler);
  }

  async enqueue(name: string, payload: unknown = {}, o: EnqueueOptions = {}): Promise<{ id: string; deduped: boolean }> {
    try {
      const doc = await Job.create({
        queue: o.queue ?? 'default',
        name,
        payload,
        dedupeKey: o.dedupeKey,
        runAt: new Date(Date.now() + (o.delayMs ?? 0)),
        maxAttempts: o.maxAttempts ?? 5,
        status: 'queued',
      });
      metrics.inc('orvia_jobs_enqueued_total', { name });
      return { id: String(doc._id), deduped: false };
    } catch (e) {
      if ((e as { code?: number }).code === 11000 && o.dedupeKey) {
        const existing = await Job.findOne({ dedupeKey: o.dedupeKey, status: { $in: ['queued', 'active'] } }).lean();
        return { id: String(existing?._id ?? ''), deduped: true };
      }
      throw e;
    }
  }

  private async claim(queues: string[], lockMs: number): Promise<JobRecord | null> {
    const now = new Date();
    const doc = await Job.findOneAndUpdate(
      {
        queue: { $in: queues },
        $or: [
          { status: 'queued', runAt: { $lte: now } },
          { status: 'active', lockedUntil: { $lt: now } }, // crashed worker: lock expired
        ],
      },
      { $set: { status: 'active', lockedBy: this.workerId, lockedUntil: new Date(now.getTime() + lockMs) }, $inc: { attempts: 1 } },
      { sort: { runAt: 1 }, new: true },
    ).lean();
    return doc
      ? { _id: doc._id, name: doc.name, queue: doc.queue, payload: doc.payload, attempts: doc.attempts, maxAttempts: doc.maxAttempts }
      : null;
  }

  /** Run at most one job. Returns false when the queue is empty. Exposed for tests and the CLI. */
  async runOnce(queues = ['default'], lockMs = 120_000): Promise<boolean> {
    const job = await this.claim(queues, lockMs);
    if (!job) return false;
    const handler = this.handlers.get(job.name);
    const started = Date.now();
    try {
      if (!handler) throw new NonRetryableError(`No handler registered for job "${job.name}"`);
      const result = await handler(job.payload as never, job);
      await Job.updateOne({ _id: job._id }, { $set: { status: 'completed', completedAt: new Date(), result: result ?? null, lockedUntil: null } });
      metrics.inc('orvia_jobs_total', { name: job.name, outcome: 'ok' });
    } catch (err) {
      const e = err as Error;
      const fatal = e instanceof NonRetryableError;
      metrics.inc('orvia_jobs_total', { name: job.name, outcome: fatal || job.attempts >= job.maxAttempts ? 'dead' : 'retry' });
      this.log.warn({ channel: 'queue', job: job.name, attempt: job.attempts, err: e.message }, 'job failed');
      if (fatal || job.attempts >= job.maxAttempts) {
        await Job.updateOne({ _id: job._id }, { $set: { status: 'dead', lastError: e.message, lockedUntil: null } });
        metrics.inc('orvia_queue_failures_total', { name: job.name });
        try {
          await this.onDead?.(job, e);
        } catch (hookErr) {
          this.log.error({ channel: 'error', err: (hookErr as Error).message }, 'dead-letter hook failed');
        }
      } else {
        await Job.updateOne(
          { _id: job._id },
          { $set: { status: 'queued', lastError: e.message, lockedUntil: null, runAt: new Date(Date.now() + backoffDelay(job.attempts, 2000, 2, 10 * 60_000)) } },
        );
      }
    } finally {
      metrics.observe('orvia_job_duration_seconds', (Date.now() - started) / 1000, { name: job.name });
    }
    return true;
  }

  /** Drain everything that is due right now (tests / one-shot CLI). */
  async drain(max = 200, queues = ['default']): Promise<number> {
    let n = 0;
    while (n < max && (await this.runOnce(queues))) n++;
    return n;
  }

  start(opts: { concurrency?: number; pollMs?: number; queues?: string[] } = {}): void {
    if (this.running) return;
    this.running = true;
    const { concurrency = 4, pollMs = 1000, queues = ['default'] } = opts;
    for (let i = 0; i < concurrency; i++) {
      this.loops.push(
        (async () => {
          while (this.running) {
            try {
              const did = await this.runOnce(queues);
              if (!did) await sleep(pollMs);
            } catch (e) {
              this.log.error({ channel: 'error', err: (e as Error).message }, 'queue loop error');
              await sleep(pollMs * 2);
            }
          }
        })(),
      );
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    await Promise.all(this.loops);
    this.loops = [];
  }

  async stats(): Promise<Record<string, number>> {
    const rows = await Job.aggregate<{ _id: string; n: number }>([{ $group: { _id: '$status', n: { $sum: 1 } } }]);
    return Object.fromEntries(rows.map((r) => [r._id, r.n]));
  }
}

export interface ScheduleDef {
  name: string;
  everyMs: number;
  job: string;
  payload?: unknown;
  description: string;
}

/**
 * Cron-ish recurring scheduler that survives restarts and multiple replicas: each time slot is
 * claimed atomically in MongoDB, so only one instance enqueues it. Not setInterval-driven state.
 */
export class Scheduler {
  private timer?: NodeJS.Timeout;
  constructor(
    private readonly queue: JobQueue,
    private readonly schedules: ScheduleDef[] | (() => Promise<ScheduleDef[]>),
    private readonly log: Logger,
  ) {}

  async tick(now = Date.now()): Promise<string[]> {
    const fired: string[] = [];
    const list = typeof this.schedules === 'function' ? await this.schedules() : this.schedules;
    for (const s of list) {
      const slot = Math.floor(now / s.everyMs);
      const key = `schedule:${s.name}`;
      try {
        const r = await SystemSetting.updateOne(
          { key, $or: [{ 'value.slot': { $lt: slot } }, { value: { $exists: false } }] },
          { $set: { value: { slot, firedAt: new Date(now) } } },
          { upsert: true },
        );
        if (r.modifiedCount || r.upsertedCount) {
          await this.queue.enqueue(s.job, s.payload ?? {}, { dedupeKey: `${key}:${slot}` });
          fired.push(s.name);
        }
      } catch (e) {
        if ((e as { code?: number }).code !== 11000) this.log.error({ channel: 'error', err: (e as Error).message, schedule: s.name }, 'scheduler error');
      }
    }
    return fired;
  }

  start(tickMs = 15_000): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), tickMs);
    this.timer.unref?.();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
