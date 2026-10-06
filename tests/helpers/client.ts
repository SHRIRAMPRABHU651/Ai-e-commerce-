import type { FastifyInstance } from 'fastify';
import { MockStore } from '@orvia/database';
import { buildServer } from '../../apps/api/src/server';
import type { Ctx } from '@orvia/core';

export class Client {
  cookies: Record<string, string> = {};
  remoteAddress?: string;
  constructor(private app: FastifyInstance, private headers: Record<string, string> = {}) {}

  async req<T = any>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown, extra: Record<string, string> = {}) {
    const cookie = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await this.app.inject({
      method, url, payload: body as object | undefined, remoteAddress: this.remoteAddress,
      headers: { 'x-requested-with': 'orvia', ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...this.headers, ...extra },
    });
    for (const c of res.cookies) {
      if (c.value === '' || (c.expires && c.expires.getTime() < Date.now())) delete this.cookies[c.name];
      else this.cookies[c.name] = c.value;
    }
    let json: T | undefined;
    try { json = res.json() as T; } catch { /* non-json */ }
    return { status: res.statusCode, body: json as T, headers: res.headers, raw: res.body, buffer: res.rawPayload };
  }
  /** multipart/form-data upload (one file part + optional text fields). */
  async upload(url: string, file: { filename: string; mimetype: string; buffer: Buffer }, fields: Record<string, string> = {}) {
    const boundary = '----orviaTest' + Math.random().toString(16).slice(2);
    const parts: Buffer[] = [];
    for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.mimetype}\r\n\r\n`), file.buffer, Buffer.from(`\r\n--${boundary}--\r\n`));
    const cookie = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await this.app.inject({ method: 'POST', url, payload: Buffer.concat(parts), remoteAddress: this.remoteAddress, headers: { 'x-requested-with': 'orvia', 'content-type': `multipart/form-data; boundary=${boundary}`, ...(cookie ? { cookie } : {}), ...this.headers } });
    let json: any; try { json = res.json(); } catch { /* non-json */ }
    return { status: res.statusCode, body: json, raw: res.body };
  }
  get = <T = any>(url: string, extra?: Record<string, string>) => this.req<T>('GET', url, undefined, extra);
  post = <T = any>(url: string, body: unknown = {}, extra?: Record<string, string>) => this.req<T>('POST', url, body, extra);
  put = <T = any>(url: string, body: unknown = {}) => this.req<T>('PUT', url, body);
  patch = <T = any>(url: string, body: unknown = {}) => this.req<T>('PATCH', url, body);
  del = <T = any>(url: string) => this.req<T>('DELETE', url);
}

export async function startApi(ctx: Ctx) {
  const app = await buildServer(ctx, { withJobHandlers: false });
  return { app, client: (headers?: Record<string, string>) => new Client(app, headers) };
}

/** Make mock supplier orders look `days` old so tracking advances deterministically. */
export async function ageMockOrders(days: number, timeScale = 60): Promise<void> {
  const rows = await MockStore.find({ kind: 'order' });
  for (const r of rows) {
    const d = r.data as { createdAt: string };
    await MockStore.updateOne({ _id: r._id }, { $set: { 'data.createdAt': new Date(Date.parse(d.createdAt) - ((days * 86_400) / timeScale) * 1000).toISOString() } });
  }
}

export const address = {
  US: { fullName: 'Test Buyer', line1: '1600 Market Street', line2: '', city: 'San Francisco', region: 'CA', postalCode: '94102', country: 'US', phone: '4155550100' },
  CA: { fullName: 'Test Buyer', line1: '100 King Street West', line2: '', city: 'Toronto', region: 'ON', postalCode: 'M5X 1A9', country: 'CA', phone: '4165550100' },
  IN: { fullName: 'Test Buyer', line1: '12 MG Road, Indiranagar', line2: '', city: 'Bengaluru', region: 'KA', postalCode: '560038', country: 'IN', phone: '9876543210' },
} as const;
