import mongoose from 'mongoose';

export interface ConnectOptions {
  uri: string;
  autoIndex?: boolean;
  maxPoolSize?: number;
}

export async function connectDb(opts: ConnectOptions): Promise<typeof mongoose> {
  mongoose.set('strictQuery', true);
  // NOTE: user input never reaches query filters unvalidated — the API validates every body/query with zod
  // and a global hook rejects `$`/dotted keys (see apps/api security plugin).
  mongoose.set('autoIndex', opts.autoIndex ?? false);
  await mongoose.connect(opts.uri, {
    maxPoolSize: opts.maxPoolSize ?? 20,
    serverSelectionTimeoutMS: 8000,
    socketTimeoutMS: 30_000,
  });
  return mongoose;
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}

export function dbReady(): boolean {
  return mongoose.connection.readyState === 1;
}

export async function pingDb(): Promise<boolean> {
  try {
    await mongoose.connection.db?.admin().ping();
    return true;
  } catch {
    return false;
  }
}

/** Create/verify all indexes (run from `npm run migrate`; autoIndex is off in production). */
export async function syncIndexes(): Promise<void> {
  for (const m of Object.values(mongoose.models)) {
    await m.syncIndexes();
  }
}
