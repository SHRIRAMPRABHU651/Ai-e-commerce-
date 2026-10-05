import mongoose from 'mongoose';
import { loadConfig } from '@orvia/config';
import { connectDb, disconnectDb, syncIndexes } from '@orvia/database';
import { buildCtx, registerJobs } from '@orvia/core';
import type { Ctx } from '@orvia/core';

export async function testCtx(name: string, env: Record<string, string> = {}): Promise<Ctx> {
  const uri = (process.env.TEST_MONGO_URI ?? 'mongodb://127.0.0.1:27017/') .replace(/\/?$/, '/') + `orvia_${name}_${process.pid}`;
  const cfg = loadConfig({ NODE_ENV: 'test', MONGODB_URI: uri, LOG_LEVEL: 'silent', MOCK_TIME_SCALE: '86400', ...env } as NodeJS.ProcessEnv);
  await connectDb({ uri, autoIndex: true });
  await mongoose.connection.dropDatabase();
  await syncIndexes();
  const ctx = buildCtx({ cfg, service: 'test' });
  registerJobs(ctx);
  return ctx;
}

export async function closeCtx(): Promise<void> {
  await mongoose.connection.dropDatabase().catch(() => undefined);
  await disconnectDb();
}
