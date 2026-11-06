import { Shipment } from '@orvia/database';
import { FeedSupplierProvider } from '@orvia/suppliers';
import type { Ctx } from '../../infra/context';
import { guardedFetch } from '../../infra/ssrf';

const done = new WeakSet<object>();

/** Idempotently registers the `feed` adapter on this context's supplier registry (SSRF-safe fetch + shipment lookup). */
export function ensureFeedAdapter(ctx: Ctx): void {
  if (done.has(ctx.suppliers)) return;
  done.add(ctx.suppliers);
  ctx.suppliers.registerFactory('feed', (s) => new FeedSupplierProvider(s.code, s.config, s.credentials?.['apiKey'], {
    fetchText: async (url, headers) => {
      const r = await guardedFetch(url, { allowPrivate: ctx.cfg.ALLOW_PRIVATE_FETCH, headers, maxBytes: 20_000_000, timeoutMs: 20_000 });
      return { status: r.status, text: r.body.toString('utf8') };
    },
    shipmentLookup: async (supplierOrderId) => {
      const sh = await Shipment.findOne({ supplierOrderId }).lean();
      return sh ? { status: sh.status, trackingNumber: sh.trackingNumber ?? undefined, carrier: sh.carrier ?? undefined, createdAt: new Date((sh as unknown as { createdAt: Date }).createdAt) } : null;
    },
  }));
}
