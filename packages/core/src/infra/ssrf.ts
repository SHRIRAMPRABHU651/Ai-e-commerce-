import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** Reject loopback, private, link-local, CGNAT, multicast and metadata addresses (IPv4 + IPv6). */
export function isPrivateAddress(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  if (isIP(v) === 6) return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff');
  const p = v.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p as [number, number, number, number];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

export interface GuardOptions {
  /** Development/test only (ALLOW_PRIVATE_FETCH): permit localhost/private targets such as fake supplier servers. */
  allowPrivate?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
  method?: 'GET' | 'HEAD';
  fetchImpl?: typeof fetch;
}

export class FetchBlockedError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
    this.name = 'FetchBlockedError';
  }
}

export async function assertPublicUrl(raw: string, allowPrivate = false): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new FetchBlockedError('Invalid URL');
  }
  if (!/^https?:$/.test(u.protocol)) throw new FetchBlockedError('Only http(s) URLs are allowed');
  if (u.username || u.password) throw new FetchBlockedError('URLs with credentials are not allowed');
  if (!allowPrivate) {
    if (u.port && !['80', '443'].includes(u.port)) throw new FetchBlockedError('Only ports 80/443 are allowed');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
    if (!addrs.length) throw new FetchBlockedError(`Cannot resolve ${host}`, true);
    if (addrs.some((a) => isPrivateAddress(a.address))) throw new FetchBlockedError('URL resolves to a private or reserved address');
  }
  return u;
}

export interface GuardedResponse {
  status: number;
  headers: Headers;
  body: Buffer;
  url: string;
}

/**
 * SSRF-safe fetch for operator-supplied or third-party URLs (supplier images, crawler sources):
 * public hosts only, redirects re-validated hop by hop, response size and time bounded.
 * (DNS is resolved before connecting; a rebinding race is possible in theory — run workers without access to internal networks.)
 */
export async function guardedFetch(raw: string, o: GuardOptions = {}): Promise<GuardedResponse> {
  const doFetch = o.fetchImpl ?? fetch;
  const maxBytes = o.maxBytes ?? 10_000_000;
  let url = raw;
  for (let hop = 0; hop <= (o.maxRedirects ?? 3); hop++) {
    const u = await assertPublicUrl(url, o.allowPrivate);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 15_000);
    try {
      const res = await doFetch(u, { method: o.method ?? 'GET', headers: o.headers, redirect: 'manual', signal: ctrl.signal });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        url = new URL(res.headers.get('location')!, u).toString();
        continue;
      }
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > maxBytes) throw new FetchBlockedError(`Response too large (${declared} bytes)`);
      const chunks: Buffer[] = [];
      let size = 0;
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) {
            await reader.cancel();
            throw new FetchBlockedError(`Response exceeds ${maxBytes} bytes`);
          }
          chunks.push(Buffer.from(value));
        }
      }
      return { status: res.status, headers: res.headers, body: Buffer.concat(chunks), url: u.toString() };
    } catch (e) {
      if (e instanceof FetchBlockedError) throw e;
      throw new FetchBlockedError(`Fetch failed: ${(e as Error).message}`, true);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new FetchBlockedError('Too many redirects');
}
