import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/ui-e2e",
  testMatch: "**/*.spec.mjs",
  timeout: 60000,
  expect: { timeout: 15000 },
  workers: 1,
  use: {
    browserName: "chromium",
    actionTimeout: 15000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
