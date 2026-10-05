// Runtime reverse proxy to the Orvia API (the browser only ever talks to its own origin, so session cookies
// are first-party). Unlike next.config `rewrites()`, the target is read from API_URL at *request time*, so one
// built image works in every environment.
import type { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length'];

async function proxy(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const base = (process.env.API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
  const target = `${base}/api/v1/${path.map(encodeURIComponent).join('/')}${req.nextUrl.search}`;
  const headers = new Headers(req.headers);
  for (const h of HOP_BY_HOP) headers.delete(h);
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body: hasBody ? req.body : undefined,
      // @ts-expect-error Node's fetch requires `duplex` when streaming a request body
      duplex: hasBody ? 'half' : undefined,
      redirect: 'manual',
      cache: 'no-store',
    });
  } catch {
    return Response.json({ error: { code: 'UPSTREAM_UNAVAILABLE', message: 'The service is temporarily unavailable. Please try again.' } }, { status: 502 });
  }
  const out = new Headers(upstream.headers);
  for (const h of [...HOP_BY_HOP, 'content-encoding']) out.delete(h); // fetch() already decoded the body
  return new Response(upstream.status === 204 || upstream.status === 304 ? null : upstream.body, { status: upstream.status, headers: out });
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE, proxy as OPTIONS };
