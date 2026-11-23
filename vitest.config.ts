import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      // Engine tests enumerate real Showdown battles (2-3 s each alone); with the parallel work sessions loading the
      // machine, the 5 s default timed out in the full suite. 20 s still catches a hang.
      { test: { name: 'unit', include: ['test/unit/**/*.test.ts'], testTimeout: 20_000 } },
      {
        plugins: [react()],
        test: {
          name: 'web',
          include: ['test/unit/web/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['test/unit/web/setup.ts'],
          // The same as `unit`, for the same reason: page tests that walk several steps (lineFollow) take about 1 s alone
          // but went past the 5 s default in the full suite on the loaded machine. 20 s still catches a hang.
          testTimeout: 20_000,
        },
      },
      {
        test: {
          name: 'real',
          include: ['test/real/**/*.test.ts'],
          // Refreshes the docs and PKCalc caches once, before the test files (which run in parallel) read them.
          globalSetup: ['test/real/globalSetup.ts'],
          // The real tests sweep every trainer through the AI and the engine; with the parallel work sessions loading the
          // machine (load 25 on 12 threads), the AI sweep took over 120 s. 10 minutes still catches a hang.
          testTimeout: 600_000,
          hookTimeout: 600_000,
        },
      },
    ],
  },
});
