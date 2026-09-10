import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  testIgnore: ["static-demo.spec.ts", "workflow.spec.ts"],
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:5173",
    locale: "en-US",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: "npm run dev",
    env: { SW_DEFAULT_MODE: "team" },
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !process.env.CI,
  },
  reporter: [["list"], ["html", { open: "never" }]],
});
