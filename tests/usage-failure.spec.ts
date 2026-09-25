/**
 * Domain failures for the usage and catalog Remotes.
 *
 * A missing credential is a configuration fact — retrying cannot help and the
 * reading belongs to a different account — while any other failure keeps the
 * last reading and marks it stale.
 */
import { describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { catalogFailure } from '../src/catalog/service.ts'
import { usageFailure } from '../src/usage/service.ts'

describe('usageFailure', () => {
  it('reports a missing credential as non-retryable with nothing to retain', () => {
    const error = usageFailure(new LlmError('no key', 'MISSING_CREDENTIAL'), undefined)
    expect(error).toBeInstanceOf(RemoteError)
    expect(error.code).toBe('dshopencodego/usage-unavailable')
    expect(error.details).toMatchObject({ retryable: false, retainPrevious: false })
  })

  it('reports any other failure as retryable, retaining the named source', () => {
    const error = usageFailure(new LlmError('boom', 'USAGE_UNAVAILABLE'), 'source-1')
    expect(error.details).toMatchObject({ retryable: true, retainPrevious: true, source: 'source-1' })
  })

  it('wraps a non-error failure with a display message', () => {
    const error = usageFailure('plain string', undefined)
    expect(error.details).toMatchObject({ retryable: true, retainPrevious: true })
    expect(error.message.length).toBeGreaterThan(0)
  })
})

describe('catalogFailure', () => {
  it('is always retryable and retaining', () => {
    const error = catalogFailure(new Error('offline'))
    expect(error).toBeInstanceOf(RemoteError)
    expect(error.code).toBe('dshopencodego/usage-unavailable')
    expect(error.details).toMatchObject({ retryable: true, retainPrevious: true })
  })
})
