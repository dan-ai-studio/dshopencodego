import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 20_000,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      // The published surface only: test helpers and stylesheet shims are not
      // part of what the gate should protect.
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        'src/**/*.d.ts',
        // Pure re-export barrels: import-only files, never "executed".
        'src/conversion/index.ts',
        'src/usage/index.ts',
      ],
      reporter: ['text-summary', 'text', 'html'],
      // Floor, not a goal: the numbers sit a few points under the current
      // reading (75/70/70/80 against ~79/74/74/83) so ordinary churn does not
      // fail the build, while a real regression still does.
      thresholds: {
        statements: 75,
        branches: 70,
        functions: 70,
        lines: 80,
      },
    },
  },
})
