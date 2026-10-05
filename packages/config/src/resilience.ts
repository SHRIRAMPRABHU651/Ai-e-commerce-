/** Shared plumbing for every external integration: timeout, retry+backoff, circuit breaker. */

export class ProviderError extends Error {
  readonly provider: string;
  readonly retryable: boolean;
  readonly status?: number;
  constructor(message: string, opts: { provider: string; retryable: boolean; status?: number; cause?: unknown }) {
    super(message, { cause: opts.cause });
    this.name = 'ProviderError';
    this.provider = opts.provider;
    this.retryable = opts.retryable;
    this.status = opts.status;
  }
}

export class CircuitOpenError extends ProviderError {
  constructor(provider: string) {
    super(`Circuit open for ${provider}; failing fast`, { provider, retryable: true });
    this.name = 'CircuitOpenError';
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface RetryOptions {
  retries?: number;
  baseMs?: number;
  factor?: number;
  maxMs?: number;
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

export function backoffDelay(attempt: number, baseMs = 250, factor = 2, maxMs = 15_000, jitter = true): number {
  const raw = Math.min(maxMs, baseMs * Math.pow(factor, attempt));
  return jitter ? Math.round(raw / 2 + Math.random() * (raw / 2)) : raw;
}

export async function retry<T>(fn: (attempt: number) => Promise<T>, o: RetryOptions = {}): Promise<T> {
  const retries = o.retries ?? 2;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const retryable = o.shouldRetry ? o.shouldRetry(err, attempt) : err instanceof ProviderError ? err.retryable : false;
      if (!retryable || attempt === retries) break;
      const delay = backoffDelay(attempt, o.baseMs, o.factor, o.maxMs);
      o.onRetry?.(err, attempt + 1, delay);
      await sleep(delay);
    }
  }
  throw lastErr;
}

export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private state: 'closed' | 'open' | 'half' = 'closed';
  constructor(
    readonly name: string,
    private readonly opts: { failureThreshold: number; resetMs: number } = { failureThreshold: 5, resetMs: 30_000 },
  ) {}

  get status(): 'closed' | 'open' | 'half' {
    if (this.state === 'open' && Date.now() - this.openedAt >= this.opts.resetMs) this.state = 'half';
    return this.state;
  }

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    if (this.status === 'open') throw new CircuitOpenError(this.name);
    try {
      const r = await fn();
      this.failures = 0;
      this.state = 'closed';
      return r;
    } catch (err) {
      // Only count infrastructure failures, not 4xx business errors.
      if (!(err instanceof ProviderError) || err.retryable) {
        this.failures++;
        if (this.state === 'half' || this.failures >= this.opts.failureThreshold) {
          this.state = 'open';
          this.openedAt = Date.now();
        }
      }
      throw err;
    }
  }
}

export interface FetchJsonOptions {
  provider: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Send body as x-www-form-urlencoded instead of JSON. */
  form?: boolean;
  timeoutMs?: number;
  retries?: number;
  breaker?: CircuitBreaker;
  fetchImpl?: typeof fetch;
  /** Retry non-idempotent calls only when explicitly safe (e.g. an idempotency key is sent). */
  idempotent?: boolean;
}

export async function fetchJson<T = unknown>(url: string, o: FetchJsonOptions): Promise<T> {
  const doFetch = o.fetchImpl ?? fetch;
  const method = (o.method ?? (o.body ? 'POST' : 'GET')).toUpperCase();
  const canRetry = o.idempotent ?? (method === 'GET' || method === 'HEAD');
  const attemptOnce = async (): Promise<T> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 15_000);
    try {
      const headers: Record<string, string> = { accept: 'application/json', ...(o.headers ?? {}) };
      let body: string | undefined;
      if (o.body !== undefined) {
        if (o.form) {
          headers['content-type'] = 'application/x-www-form-urlencoded';
          body = new URLSearchParams(o.body as Record<string, string>).toString();
        } else {
          headers['content-type'] = 'application/json';
          body = JSON.stringify(o.body);
        }
      }
      const res = await doFetch(url, { method, headers, body, signal: ctrl.signal });
      const text = await res.text();
      if (!res.ok) {
        throw new ProviderError(`${o.provider} ${method} responded ${res.status}: ${text.slice(0, 300)}`, {
          provider: o.provider,
          retryable: res.status === 429 || res.status >= 500,
          status: res.status,
        });
      }
      return (text ? JSON.parse(text) : {}) as T;
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      const aborted = (err as Error).name === 'AbortError';
      throw new ProviderError(aborted ? `${o.provider} request timed out` : `${o.provider} request failed: ${(err as Error).message}`, {
        provider: o.provider,
        retryable: true,
        cause: err,
      });
    } finally {
      clearTimeout(timer);
    }
  };
  const run = () =>
    retry(() => attemptOnce(), {
      retries: canRetry ? (o.retries ?? 2) : 0,
      shouldRetry: (e) => e instanceof ProviderError && e.retryable,
    });
  return o.breaker ? o.breaker.exec(run) : run();
}
