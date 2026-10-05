/** Tiny async key-value contract used by dev/test mock providers to share state between processes. */
export interface KVStore {
  get<T>(kind: string, key: string): Promise<T | null>;
  set<T>(kind: string, key: string, data: T): Promise<void>;
  /** Atomically insert; returns the existing record if the key already exists. */
  setIfAbsent<T>(kind: string, key: string, data: T): Promise<{ created: boolean; data: T }>;
}

export class MemoryKVStore implements KVStore {
  private m = new Map<string, unknown>();
  async get<T>(kind: string, key: string): Promise<T | null> {
    return (this.m.get(`${kind}:${key}`) as T | undefined) ?? null;
  }
  async set<T>(kind: string, key: string, data: T): Promise<void> {
    this.m.set(`${kind}:${key}`, data);
  }
  async setIfAbsent<T>(kind: string, key: string, data: T): Promise<{ created: boolean; data: T }> {
    const k = `${kind}:${key}`;
    if (this.m.has(k)) return { created: false, data: this.m.get(k) as T };
    this.m.set(k, data);
    return { created: true, data };
  }
}
