// Verifies that every bare module imported by a bundled app entry resolves from that app's
// directory. Internal packages are bundled; third-party packages stay external and must be
// declared as dependencies of the app itself (pnpm does not hoist transitive dependencies).
import { readFileSync } from 'node:fs';
import { createRequire, builtinModules } from 'node:module';
import path from 'node:path';

const [, , appDir, ...entries] = process.argv;
if (!appDir || entries.length === 0) {
  console.error('usage: verify-bundle-deps.mjs <appDir> <dist entry...>');
  process.exit(2);
}

const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
const requireFromApp = createRequire(path.resolve(appDir, 'package.json'));
const pattern = /(?:from\s*|import\s*\(\s*|import\s+|require\s*\(\s*)["']([^"'./][^"']*)["']/g;
const missing = new Set();

for (const entry of entries) {
  const source = readFileSync(path.resolve(appDir, entry), 'utf8');
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1];
    if (builtins.has(specifier) || specifier.startsWith('node:')) continue;
    if (specifier.startsWith('@businessos/')) {
      missing.add(`${specifier} (internal packages must be bundled)`);
      continue;
    }
    try {
      requireFromApp.resolve(specifier);
    } catch {
      try {
        // ESM-only packages may not expose a CommonJS entry; check the package.json instead.
        const name = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0];
        requireFromApp.resolve(`${name}/package.json`);
      } catch {
        missing.add(specifier);
      }
    }
  }
}

if (missing.size > 0) {
  console.error(`Unresolvable imports in ${appDir}:\n  - ${[...missing].join('\n  - ')}`);
  console.error('Add them to the app package.json dependencies.');
  process.exit(1);
}
console.log(`verify-bundle-deps: ${appDir} ok`);
