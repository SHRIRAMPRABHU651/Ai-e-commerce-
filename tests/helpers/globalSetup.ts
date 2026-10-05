import { MongoMemoryServer } from 'mongodb-memory-server';

let mongod: MongoMemoryServer | undefined;

/** One shared in-memory MongoDB for the whole suite; each integration test file uses its own database. */
export async function setup(): Promise<void> {
  if (process.env.TEST_MONGO_URI) return;
  mongod = await MongoMemoryServer.create({ instance: { storageEngine: 'wiredTiger' } });
  process.env.TEST_MONGO_URI = mongod.getUri();
}

export async function teardown(): Promise<void> {
  await mongod?.stop();
}
