import type { NextConfig } from 'next';

const apiInternalUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: [],
  // Same-origin access to the API keeps session cookies first-party (ADR-009).
  rewrites: () =>
    Promise.resolve([{ source: '/api/:path*', destination: `${apiInternalUrl}/:path*` }]),
  headers: () => Promise.resolve([{ source: '/:path*', headers: securityHeaders }]),
};

export default config;
