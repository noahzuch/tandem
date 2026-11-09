// End-to-end tests: they run the built plugin through plugin/bin/tandem, as Claude Code will.

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  forbidOnly: !!process.env.CI,
  retries: 0,
  // Traces and screenshots of failed tests; the HTML report goes to reports/e2e/html (see mise.toml, e2e-ci).
  outputDir: 'reports/e2e/results',
  reporter: 'list',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
