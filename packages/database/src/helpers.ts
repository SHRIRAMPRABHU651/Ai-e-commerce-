import mongoose, { Schema } from 'mongoose';
import type { InferSchemaType, Model, SchemaOptions } from 'mongoose';

export const { ObjectId } = mongoose.Types;
export const Mixed = Schema.Types.Mixed;
export const oid = Schema.Types.ObjectId;

export const schemaOpts = { timestamps: true, versionKey: 'version' } as const satisfies SchemaOptions;

/** Register (or reuse) a model so repeated imports / hot reloads don't throw OverwriteModelError. */
export function defineModel<S extends Schema>(name: string, schema: S, collection: string) {
  return (
    (mongoose.models[name] as Model<InferSchemaType<S>> | undefined) ??
    mongoose.model<InferSchemaType<S>>(name, schema, collection)
  );
}

const intMoney = (v: number) => Number.isInteger(v);
/** Integer minor units, never negative. */
export const money = { type: Number, default: 0, min: 0, validate: intMoney };
/** Integer minor units, may be negative (profit, adjustments). */
export const signedMoney = { type: Number, default: 0, validate: intMoney };
export const COUNTRY = { type: String, enum: ['US', 'CA', 'IN'] };
