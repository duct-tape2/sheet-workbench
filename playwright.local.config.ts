import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e', testMatch: 'local-workbench.spec.ts',
  outputDir: 'test-results-local', fullyParallel: false, timeout: 45000,
  use: { baseURL: 'http://127.0.0.1:4174/sheet-workbench/', locale: 'en-US', trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: {...devices['Desktop Chrome']} },
    { name: 'webkit', use: {...devices['Desktop Safari']} },
  ],
  webServer: {
    command: 'npm run build:local -- --base /sheet-workbench/ --outDir ../../dist/local && npx vite preview --host 127.0.0.1 --port 4174 --strictPort --base /sheet-workbench/ --outDir ../../dist/local',
    url: 'http://127.0.0.1:4174/sheet-workbench/', reuseExistingServer: false,
  },
  reporter: [['list'], ['html', {open:'never',outputFolder:'playwright-report-local'}]],
});
