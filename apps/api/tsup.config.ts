import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  // Internal workspace packages are source-only TypeScript and are bundled. Third-party
  // packages stay external and must be declared by this app (checked by verify-bundle-deps).
  noExternal: [/^@businessos\//],
  external: [/^(?!@businessos\/)[^./]/],
});
