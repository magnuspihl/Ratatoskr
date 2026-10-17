import { defineConfig } from 'vitest/config';

// Integration tests run against a real IMAP/SMTP server (GreenMail in Docker). The global setup
// starts the container and removes it when the run ends.
export default defineConfig({
  test: {
    include: ['server/test/integration/**/*.test.ts'],
    globalSetup: ['server/test/integration/greenmail.setup.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
