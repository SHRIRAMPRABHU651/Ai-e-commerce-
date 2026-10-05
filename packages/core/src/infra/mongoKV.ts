import { MockStore } from '@orvia/database';
import type { KVStore } from '@orvia/config';

/** KVStore backed by MongoDB so mock providers share state between the API and worker processes. */
export class MongoKVStore implements KVStore {
  async get<T>(kind: string, key: string): Promise<T | null> {
    const d = await MockStore.findOne({ kind, key }).lean();
    return (d?.data as T | undefined) ?? null;
  }
  async set<T>(kind: string, key: string, data: T): Promise<void> {
    await MockStore.updateOne({ kind, key }, { $set: { data } }, { upsert: true });
  }
  async setIfAbsent<T>(kind: string, key: string, data: T): Promise<{ created: boolean; data: T }> {
    try {
      const r = await MockStore.updateOne({ kind, key }, { $setOnInsert: { data } }, { upsert: true });
      if (r.upsertedCount) return { created: true, data };
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
    }
    const existing = await MockStore.findOne({ kind, key }).lean();
    return { created: false, data: existing?.data as T };
  }
}
