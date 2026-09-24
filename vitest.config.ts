import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 20_000,
    restoreMocks: true,
  },
})
