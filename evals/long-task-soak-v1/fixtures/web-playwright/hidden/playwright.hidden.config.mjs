// Oracle-only config: runs the hidden spec on chromium against `npm start`.
// PORT is chosen by hidden/scripts/oracle.sh (workers reload this file, so
// the port must come from the environment, not be picked here).
import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.PORT ?? 4173);

export default defineConfig({
  testDir: 'e2e',
  testMatch: 'zz-hidden.spec.js',
  fullyParallel: true,
  workers: 4,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  outputDir: 'test-results-hidden',
  use: { baseURL: `http://127.0.0.1:${port}` },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: { command: 'npm start', url: `http://127.0.0.1:${port}/`, env: { PORT: String(port) }, reuseExistingServer: false, timeout: 30_000 },
});
