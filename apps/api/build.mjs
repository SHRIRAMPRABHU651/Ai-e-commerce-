import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/main.js',
  sourcemap: true,
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  // keep native/optional deps external; they are installed in the runtime image
  external: ['mongodb-memory-server', 'ioredis', 'mongoose', 'stripe', 'pino', 'fastify', '@fastify/*', 'jose', 'zod'],
});
console.log('api built -> dist/main.js');
