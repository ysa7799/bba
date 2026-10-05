import type { NextConfig } from 'next';

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

/** No framing anywhere, except embedded forms (their per-form policy is set in src/proxy.ts). */
const noFraming = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
];

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: [],
  // `/api/*` is proxied to the API at runtime by `src/app/api/[...path]/route.ts` (ADR-009).
  headers: () =>
    Promise.resolve([
      { source: '/:path*', headers: securityHeaders },
      { source: '/((?!f/[^/]+/embed).*)', headers: noFraming },
    ]),
};

export default config;
