// Flat ESLint config for the Next.js app: shared TS rules + Next/React rules.
import nextVitals from 'eslint-config-next/core-web-vitals';
import globals from 'globals';
import { createConfig } from './base.js';

/**
 * @param {{ tsconfigRootDir: string }} options
 */
export function createNextConfig({ tsconfigRootDir }) {
  return [
    ...nextVitals,
    ...createConfig({ tsconfigRootDir }),
    {
      languageOptions: { globals: { ...globals.browser } },
    },
  ];
}
