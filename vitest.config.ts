// Unit tests: a Node project for src/cli, src/server and src/shared and a happy-dom project for src/web.
// Coverage gate: every measured file must reach 80 % line and branch coverage on its own. `mise run test-ci` passes
// `--coverage.changed=<base>`, so in CI only the files changed since the base are measured, and with them gated; a
// changed file without tests counts as 0 %.

import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/{cli,server,shared}/**/*.test.ts'],
        },
      },
      {
        plugins: [vue()],
        test: {
          name: 'web',
          environment: 'happy-dom',
          include: ['src/web/**/*.test.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      // Listed explicitly, so that a file no test imports still shows up (at 0 %).
      include: ['src/**/*.ts', 'src/**/*.vue'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts'],
      reporter: [['text', { skipFull: false }], 'html', 'json-summary'],
      reportsDirectory: 'reports/coverage',
      thresholds: { perFile: true, lines: 80, branches: 80 },
    },
  },
});
