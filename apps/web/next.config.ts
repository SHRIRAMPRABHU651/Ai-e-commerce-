import type { NextConfig } from 'next';

const API_URL = process.env.API_URL ?? 'http://localhost:4000';

const config: NextConfig = {
  transpilePackages: ['@orvia/ui', '@orvia/types', '@orvia/analytics'],
  poweredByHeader: false,
  reactStrictMode: true,
  output: process.env.NEXT_OUTPUT === 'standalone' ? 'standalone' : undefined,
  images: { unoptimized: true },
  // Browser talks to the same origin; Next proxies API calls so cookies are first-party (no CORS, SameSite=Lax works).
  async rewrites() {
    return [
      { source: '/api/v1/:path*', destination: `${API_URL}/api/v1/:path*` },
      { source: '/docs', destination: `${API_URL}/docs` },
    ];
  },
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
