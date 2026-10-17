import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 20_000,
    restoreMocks: true,
    // Isolation stays on. Measured on a frozen copy of this tree (36 files /
    // 269 cases, identical sources for both groups): `isolate: false` reuses
    // one worker across files, which was 2.3s faster on its good run
    // (8.84s vs 11.09s) but did not reproduce — its second run took 17.26s and
    // reported an extra failure in tests/adapter-stream-teardown.spec.ts, while
    // both isolated runs came back identical. `tests/setup.ts` installs global
    // stubs per file and depends on that boundary; a flaky suite is not worth
    // ~2s.
    pool: 'forks',
    isolate: true,
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
