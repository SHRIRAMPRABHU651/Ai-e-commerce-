// Local MongoDB without Docker: starts a persistent mongod via mongodb-memory-server on :27017.
import { MongoMemoryServer } from 'mongodb-memory-server';
import { mkdirSync } from 'node:fs';

const dbPath = new URL('../.mongo-data', import.meta.url).pathname;
mkdirSync(dbPath, { recursive: true });
const port = Number(process.env.MONGO_PORT ?? 27017);
const server = await MongoMemoryServer.create({ instance: { port, dbPath, storageEngine: 'wiredTiger' } });
console.log(`[dev-mongo] ${server.getUri()} (data: ${dbPath})`);
const stop = async () => { await server.stop({ doCleanup: false }); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
