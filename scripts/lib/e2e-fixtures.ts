/**
 * Extra DEV-ONLY fixtures for the Playwright suite (tests/e2e/*), applied after `runSeed` by scripts/e2e-seed.ts.
 * Kept out of scripts/lib/seed.ts on purpose so the deterministic seed (and tests/integration/seed.test.ts, which counts suppliers) is unchanged.
 *
 * Adds one SUPPLIER-role user linked to one MANUAL supplier that has one shipment waiting to be shipped, so the supplier-portal
 * "mark shipped" flow can be exercised in a browser. The supplier is inactive (never routed real orders) and the order is a fixture.
 */
import { hashPassword } from '@orvia/auth';
import { Order, Product, Shipment, Supplier, SuppliernetProfile, User } from '@orvia/database';
import type { Ctx } from '@orvia/core';
import { SEED_PASSWORD } from './seed';

export const E2E_SUPPLIER = { email: 'supplier@e2e.orvia.test', password: SEED_PASSWORD, code: 'e2e-manual', orderNumber: 'ORV-E2ESUPPL-A1B2C3' } as const;

export async function seedE2eFixtures(ctx: Ctx): Promise<{ supplierId: string; shipmentId: string }> {
  if (ctx.cfg.isProduction || ctx.cfg.APP_ENV === 'production') throw new Error('Refusing to seed e2e fixtures: APP_ENV=production');
  const passwordHash = await hashPassword(E2E_SUPPLIER.password, { fast: ctx.cfg.isTest });
  const user = await User.findOneAndUpdate({ email: E2E_SUPPLIER.email }, { $set: { name: 'E2E Supplier Contact', role: 'SUPPLIER', passwordHash, emailVerified: true, isDemo: true } }, { upsert: true, new: true });
  const supplier = await Supplier.findOneAndUpdate(
    { code: E2E_SUPPLIER.code },
    { $set: { name: 'E2E Manual Supplier', provider: 'manual', servesCountries: ['US'], active: false, isDemo: true, fulfillmentMode: 'MANUAL', userIds: [user._id] } },
    { upsert: true, new: true },
  );
  // same shape `inviteSupplier` creates, so the portal dashboard/verification pages behave as for a really invited supplier
  await Supplier.updateOne({ _id: supplier._id }, { $set: { 'network.state': 'invited', 'network.supplierType': 'wholesaler', 'network.productionReady': false } });
  if (!(await SuppliernetProfile.exists({ supplierId: supplier._id }))) {
    await SuppliernetProfile.create({ supplierId: supplier._id, supplierType: 'wholesaler', state: 'invited', invitedEmail: E2E_SUPPLIER.email, history: [{ from: null, to: 'invited', at: ctx.now(), by: 'e2e-fixture', reason: 'e2e fixture' }] });
  }
  const product = await Product.findOne({ state: 'PUBLISHED' }).select('_id').lean();
  if (!product) throw new Error('e2e fixtures need the seeded catalog (run the seed first)');
  let order = await Order.findOne({ orderNumber: E2E_SUPPLIER.orderNumber });
  if (!order) {
    order = await Order.create({
      orderNumber: E2E_SUPPLIER.orderNumber, idempotencyKey: 'e2e-supplier-fixture-order', email: 'fixture@e2e.orvia.test', country: 'US', currency: 'USD',
      items: [{ productId: product._id, sku: 'E2E-SKU-1', title: 'E2E fixture item', quantity: 1, unitPrice: 1999, lineKey: 'E2E-L1' }],
      address: { fullName: 'Fixture Recipient', line1: '1 Fixture Way', city: 'Austin', region: 'TX', postalCode: '78701', country: 'US', phone: '5125550100' },
      shippingMethod: 'standard', amounts: { subtotal: 1999, discount: 0, shipping: 0, tax: 0, total: 1999, taxInclusive: false },
      status: 'SUPPLIER_PROCESSING', payment: { provider: 'mock', status: 'succeeded' }, fulfillment: { state: 'placed' },
    });
  }
  const shipment = await Shipment.findOneAndUpdate(
    { idempotencyKey: 'e2e-supplier-fixture-shipment' },
    { $setOnInsert: { orderId: order._id, lineKey: 'E2E-L1', productId: product._id, sku: 'E2E-SKU-1', quantity: 1, supplierId: supplier._id, status: 'CREATED', cost: { productCost: 800, shippingCost: 200, duties: 0, currency: 'USD' } } },
    { upsert: true, new: true },
  );
  return { supplierId: String(supplier._id), shipmentId: String(shipment._id) };
}
