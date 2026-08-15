import { defineConfig } from "@playwright/test";

const requestedExecutable = process.env.PIAGENT_WEBUI_CHROMIUM;

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.e2e.mjs",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [["line"]],
  outputDir: ".tmp/playwright-webui",
  use: {
    browserName: "chromium",
    launchOptions: requestedExecutable ? { executablePath: requestedExecutable } : {},
    locale: "vi-VN",
    colorScheme: "dark",
    reducedMotion: "reduce",
    trace: "retain-on-failure"
  }
});
