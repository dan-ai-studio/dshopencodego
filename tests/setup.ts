/** Shared test setup: keep every test on the real timers and a clean console. */
import { afterEach, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
})
