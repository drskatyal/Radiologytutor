import { defineConfig } from '@playwright/test';
import path from 'node:path';
import radlearn from './playwright.radlearn.config';
// Dedicated server-transport mock run; no test hook or dummy key enters production code.
export default defineConfig({ ...radlearn, testMatch: 'exam-flow.spec.ts', projects: [{ name: 'exam-model-mock' }],
  webServer: (Array.isArray(radlearn.webServer) ? radlearn.webServer : []).map(server => ({ ...server,
    env: { ...server.env, ...(String(server.command).includes('next start') ? {
      GEMINI_API_KEY: 'synthetic-exam-transport-only',
      NODE_OPTIONS: `--import=${path.join(process.cwd(), 'e2e/support/examTransportMock.mjs')}`,
    } : {}) },
  })),
});
