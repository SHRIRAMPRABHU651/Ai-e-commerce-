/** finance: mongoose models (owned by the finance workstream). */
import { Schema } from 'mongoose';
import { Mixed, defineModel, oid, schemaOpts } from './helpers';

/** Stored FX rates (units per 1 USD). One document per fetch; the newest `fetchedAt` is current. */
const fxRateSchema = new Schema({
  base: { type: String, enum: ['USD'], default: 'USD', required: true },
  rates: { type: Mixed, required: true }, // { USD: 1, CAD: n, INR: n }
  source: { type: String, enum: ['frankfurter', 'exchangerate_api', 'static', 'manual'], required: true },
  providerDate: String,
  fetchedAt: { type: Date, required: true },
}, schemaOpts);
fxRateSchema.index({ fetchedAt: -1 });
export const FinanceFxRate = defineModel('FinanceFxRate', fxRateSchema, 'finance_fx_rates');

const lineSchema = new Schema({
  account: { type: String, required: true },
  side: { type: String, enum: ['debit', 'credit'], required: true },
  amount: { type: Number, required: true, min: 1, validate: Number.isInteger },
}, { _id: false });

/**
 * Append-only journal. One document = one balanced entry in a single currency.
 * `idempotencyKey` is unique, so reposting the same business event is a no-op.
 * Updates and deletes are rejected at the schema level; corrections are new reversal entries.
 */
const ledgerSchema = new Schema({
  idempotencyKey: { type: String, required: true, unique: true, immutable: true },
  kind: { type: String, required: true, immutable: true },
  currency: { type: String, required: true, immutable: true },
  postedAt: { type: Date, required: true, immutable: true },
  memo: { type: String, immutable: true },
  lines: { type: [lineSchema], immutable: true, validate: (v: unknown[]) => v.length >= 2 },
  refs: {
    orderId: { type: oid, immutable: true },
    paymentId: { type: oid, immutable: true },
    refundId: { type: oid, immutable: true },
    shipmentId: { type: oid, immutable: true },
    supplierId: { type: oid, immutable: true },
    supplierOrderId: { type: String, immutable: true },
    settlementId: { type: String, immutable: true },
    campaignId: { type: oid, immutable: true },
    metricId: { type: oid, immutable: true },
  },
  reverses: { type: String, immutable: true },
  /** Rate snapshot at posting: units of `currency` per 1 USD, so reports can convert without today's rate. */
  fx: { type: new Schema({ perUsd: Number, source: String, asOf: Date, basis: { type: String, enum: ['posting_time', 'backfill_current_rate'] } }, { _id: false }), immutable: true },
  createdBy: { type: String, immutable: true },
}, schemaOpts);
ledgerSchema.index({ postedAt: -1, _id: -1 });
ledgerSchema.index({ kind: 1, postedAt: -1 });
ledgerSchema.index({ 'refs.orderId': 1, kind: 1 });
ledgerSchema.index({ 'lines.account': 1, postedAt: -1 });
ledgerSchema.index({ 'refs.supplierId': 1, kind: 1, postedAt: 1 });
const reject = function (this: unknown, next: (e?: Error) => void) { next(new Error('The finance ledger is append-only: post a reversal entry instead')); };
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete'] as const) ledgerSchema.pre(op as 'updateOne', reject as never);
ledgerSchema.pre('save', function (next) { next(this.isNew ? undefined : new Error('The finance ledger is append-only: post a reversal entry instead')); });
export const FinanceLedgerEntry = defineModel('FinanceLedgerEntry', ledgerSchema, 'finance_ledger');

/** Sync watermarks etc. (key → value). */
const stateSchema = new Schema({ key: { type: String, required: true, unique: true }, value: Mixed }, schemaOpts);
export const FinanceState = defineModel('FinanceState', stateSchema, 'finance_state');
