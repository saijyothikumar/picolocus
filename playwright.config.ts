import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './sandbox/e2e',
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    channel: 'msedge',
    viewport: { width: 1280, height: 800 },
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'Microsoft Edge',
      use: {
        channel: 'msedge',
        viewport: { width: 1280, height: 800 },
      },
    },
  ],
  webServer: {
    command: 'npm run dev',
    port: 5173,
    reuseExistingServer: !process.env['CI'],
    timeout: 120000,
  },
});
