import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:4173/sheet-workbench/";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "static-demo.spec.ts",
  outputDir: "test-results-static-demo",
  fullyParallel: false,
  timeout: 30000,
  use: {
    baseURL,
    locale: "en-US",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command:
      "npm run build:static-demo -- --base /sheet-workbench/ --outDir ../../dist/static-demo && npx vite preview --host 127.0.0.1 --port 4173 --strictPort --base /sheet-workbench/ --outDir ../../dist/static-demo",
    url: baseURL,
    reuseExistingServer: false,
  },
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report-static-demo" }],
  ],
});
