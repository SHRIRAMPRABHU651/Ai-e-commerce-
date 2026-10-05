import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const config: NextConfig = {
  transpilePackages: ['@orvia/ui', '@orvia/types', '@orvia/analytics'],
  poweredByHeader: false,
  reactStrictMode: true,
  output: process.env.NEXT_OUTPUT === 'standalone' ? 'standalone' : undefined,
  // monorepo: trace dependencies from the repo root so the standalone bundle is self-contained
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  images: { unoptimized: true },
  // API calls go through the runtime proxy in src/app/api/v1/[...path]/route.ts (API_URL is read per request).
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};
export default config;
