import { defineConfig } from "@playwright/test";

// End-to-end tests drive the built Electron app. Run `npm run test:e2e` (builds first).
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  workers: 1,
  reporter: [["list"]],
  use: { trace: "retain-on-failure" },
});
