import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { AppConfig } from '@orvia/config';

/** Minimal object-storage port. Provider-specific code stays in this file; the rest of the app only sees the interface. */
export interface ObjectStorage {
  readonly provider: 'local' | 's3';
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<{ body: Buffer; contentType?: string } | null>;
  delete(key: string): Promise<void>;
  /** Public URL a browser can load (CDN for s3, API media route for local). */
  publicUrl(key: string): string;
  /** True when a URL points at storage we own (used to forbid supplier hotlinks in production). */
  owns(url: string): boolean;
  health(): Promise<{ ok: boolean; message: string }>;
}

/** Keys are generated server-side, but validate anyway: no traversal, no odd characters. */
export function assertSafeKey(key: string): void {
  if (!/^[a-z0-9][a-z0-9/_.-]{0,300}$/i.test(key) || key.includes('..') || key.includes('//')) throw new Error('Unsafe storage key');
}

const MIME_BY_EXT: Record<string, string> = { webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', avif: 'image/avif' };
export const mimeForKey = (key: string): string => MIME_BY_EXT[key.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream';

export class LocalStorage implements ObjectStorage {
  readonly provider = 'local' as const;
  private readonly root: string;
  constructor(dir: string, private readonly base = '/api/v1/media') {
    this.root = resolve(dir);
  }
  private path(key: string): string {
    assertSafeKey(key);
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new Error('Unsafe storage key');
    return p;
  }
  async put(key: string, body: Buffer): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body);
  }
  async get(key: string) {
    try {
      return { body: await readFile(this.path(key)), contentType: mimeForKey(key) };
    } catch {
      return null;
    }
  }
  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
  publicUrl(key: string): string {
    assertSafeKey(key);
    return `${this.base}/${key}`;
  }
  owns(url: string): boolean {
    return url.startsWith(`${this.base}/`);
  }
  async health() {
    try {
      await mkdir(this.root, { recursive: true });
      return { ok: true, message: `local media directory ${this.root} (development only)` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }
}

export class S3Storage implements ObjectStorage {
  readonly provider = 's3' as const;
  private readonly client: S3Client;
  constructor(private readonly o: { bucket: string; region: string; endpoint?: string; accessKey?: string; secret?: string; cdnBase: string }) {
    this.client = new S3Client({
      region: o.region,
      endpoint: o.endpoint,
      forcePathStyle: !!o.endpoint,
      credentials: o.accessKey && o.secret ? { accessKeyId: o.accessKey, secretAccessKey: o.secret } : undefined,
    });
  }
  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    assertSafeKey(key);
    await this.client.send(new PutObjectCommand({ Bucket: this.o.bucket, Key: key, Body: body, ContentType: contentType, CacheControl: 'public, max-age=31536000, immutable' }));
  }
  async get(key: string) {
    assertSafeKey(key);
    try {
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.o.bucket, Key: key }));
      return { body: Buffer.from(await r.Body!.transformToByteArray()), contentType: r.ContentType };
    } catch {
      return null;
    }
  }
  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.o.bucket, Key: key }));
  }
  publicUrl(key: string): string {
    assertSafeKey(key);
    return `${this.o.cdnBase.replace(/\/$/, '')}/${key}`;
  }
  owns(url: string): boolean {
    return url.startsWith(`${this.o.cdnBase.replace(/\/$/, '')}/`);
  }
  async health() {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.o.bucket }));
      return { ok: true, message: `bucket ${this.o.bucket} reachable` };
    } catch (e) {
      return { ok: false, message: `bucket ${this.o.bucket}: ${(e as Error).message}` };
    }
  }
}

export function buildStorage(cfg: AppConfig): ObjectStorage {
  if (cfg.OBJECT_STORAGE_PROVIDER === 's3') {
    if (!cfg.OBJECT_STORAGE_BUCKET || !cfg.CDN_BASE_URL) throw new Error('OBJECT_STORAGE_BUCKET and CDN_BASE_URL are required for s3 storage');
    return new S3Storage({ bucket: cfg.OBJECT_STORAGE_BUCKET, region: cfg.OBJECT_STORAGE_REGION, endpoint: cfg.OBJECT_STORAGE_ENDPOINT, accessKey: cfg.OBJECT_STORAGE_ACCESS_KEY, secret: cfg.OBJECT_STORAGE_SECRET, cdnBase: cfg.CDN_BASE_URL });
  }
  if (cfg.isProduction) throw new Error('Local media storage is not allowed in production');
  return new LocalStorage(cfg.LOCAL_MEDIA_DIR);
}
