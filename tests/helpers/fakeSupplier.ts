import { createServer } from 'node:http';
import type { Server } from 'node:http';

export interface FakeSupplier {
  server: Server;
  /** "METHOD /path" of every request received (authorised or not). */
  seen: string[];
  /** let tests flip behaviour at runtime */
  state: { failing: boolean; stock: number };
  start(): Promise<void>;
  stop(): Promise<void>;
  orderCount(): number;
}

/** A tiny supplier HTTP API (bearer key, products, quote, orders, tracking) for adapter/routing tests. */
export function fakeSupplier(key: string, cdn: string, port: number, ship: { cost: number; min: number; max: number }): FakeSupplier {
  const orders = new Map<string, { tracking?: { number: string; carrier: string } }>();
  const seen: string[] = [];
  const state = { failing: false, stock: 120 };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url!, `http://localhost:${port}`);
    seen.push(`${req.method} ${url.pathname}`);
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== `Bearer ${key}`) { res.statusCode = 401; return res.end('{"error":"bad key"}'); }
    if (state.failing) { res.statusCode = 503; return res.end('{"error":"down"}'); }
    const product = (id: string) => ({ id, title: 'Spiral Slow Feeder Dog Bowl', description: 'A durable bowl with a spiral maze that slows down fast eaters.', category: 'Pet', price: 4.5, stock: state.stock, images: [`${cdn}/${id}/1.jpg`, `${cdn}/${id}/2.jpg`], shipping: { cost: ship.cost, minDays: ship.min, maxDays: ship.max } });
    if (req.method === 'GET' && url.pathname === '/products') return res.end(JSON.stringify({ items: [product('P100')] }));
    const m = /^\/products\/(\w+)$/.exec(url.pathname);
    if (req.method === 'GET' && m) return res.end(JSON.stringify(product(m[1]!)));
    if (req.method === 'POST' && url.pathname === '/orders') {
      let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
        const j = JSON.parse(body) as { ref: string };
        const id = `ORD-${key}-${j.ref}`;
        if (!orders.has(id)) orders.set(id, {}); // idempotent on the reference
        res.end(JSON.stringify({ id, status: 'pending' }));
      }); return;
    }
    const o = /^\/orders\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && o) {
      const ord = orders.get(decodeURIComponent(o[1]!));
      if (!ord) { res.statusCode = 404; return res.end('{}'); }
      return res.end(JSON.stringify({ id: o[1], status: ord.tracking ? 'shipped' : 'pending', tracking: ord.tracking }));
    }
    res.statusCode = 404; res.end('{}');
  });
  return { server, seen, state, start: () => new Promise<void>((r) => server.listen(port, r)), stop: () => new Promise<void>((r) => server.close(() => r())), orderCount: () => orders.size };
}

export const restMapping = (base: string, warehouse: string) => ({
  baseUrl: base, auth: { type: 'bearer' }, currency: 'USD', warehouseCountry: warehouse,
  endpoints: {
    search: { path: '/products', query: { q: '{query}' } },
    product: { path: '/products/{id}' },
    quote: { path: '/products/{id}', query: { country: '{country}', qty: '{qty}' } },
    createOrder: { method: 'POST', path: '/orders', body: { ref: '{idempotencyKey}', sku: '{sku}', qty: '{qty}', to: '{address.fullName}' } },
    order: { path: '/orders/{id}' },
  },
});
