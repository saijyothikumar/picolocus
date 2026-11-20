import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts'],
    environment: 'node',
    environmentMatchGlobs: [
      ['packages/web/**', 'jsdom'],
    ],
    pool: 'forks',
    globals: true,
  },
});

