import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './sandbox/e2e',
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    channel: 'msedge',
    baseURL: 'http://127.0.0.1:5173',
    viewport: { width: 1280, height: 800 },
    trace: 'on-first-retry',
    launchOptions: {
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
    },
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
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env['CI'],
    timeout: 120000,
  },
});
