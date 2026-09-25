/**
 * History conversion without attachments: system folding, tool-name recovery,
 * and the refusal to silently drop images.
 */
import { describe, expect, it } from 'vitest'
import { toPiContext } from '../src/conversion/index.ts'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

function options(extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'opencode-go',
    model: 'zz-cheap',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    ...extra,
  }
}

describe('toPiContext', () => {
  it('folds an explicit system prompt and a leading system message', async () => {
    const explicit = await toPiContext(options({ system: 'be nice' }))
    expect(explicit.systemPrompt).toBe('be nice')
    expect(explicit.messages).toHaveLength(1)

    const leading = await toPiContext(options({
      messages: [
        { role: 'system', id: 'sys-1' as never, source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'be bold' }] },
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      ],
    }))
    expect(leading.systemPrompt).toBe('be bold')
    expect(leading.messages).toHaveLength(1)
    expect(leading.messages[0]).toMatchObject({ role: 'user' })
  })

  it('sends no prompt for an empty leading system message', async () => {
    const context = await toPiContext(options({
      messages: [
        { role: 'system', id: 'sys-2' as never, source: { kind: 'system-prompt' }, content: [{ type: 'text', text: '' }] },
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      ],
    }))
    expect(context.systemPrompt).toBeUndefined()
  })

  it('recovers tool names from the preceding assistant call', async () => {
    const context = await toPiContext(options({
      tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object' } }],
      messages: [
        {
          role: 'assistant',
          id: 'asst-call-1' as never,
          source: { kind: 'model', provider: 'opencode-go', model: 'zz-cheap' },
          content: [{
            type: 'tool-call',
            id: 'call_1' as never,
            name: 'read_file',
            arguments: '{"path":"a.txt"}',
          }],
        },
        { role: 'tool', toolCallId: 'call_1' as never, content: [{ type: 'text', text: 'contents' }] } as never,
      ],
    }))
    expect(context.tools).toHaveLength(1)
    const result = context.messages.find(message => message.role === 'toolResult')
    expect(result).toMatchObject({ toolCallId: 'call_1', toolName: 'read_file' })
  })

  it('refuses an image when no attachment machinery is provided', async () => {
    await expect(toPiContext(options({
      messages: [{
        role: 'user',
        content: [{ type: 'image', attachment: { attachmentId: 'a1' } } as never],
      }],
    }))).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  })

  it('refuses an image on an assistant history message', async () => {
    await expect(toPiContext(options({
      messages: [{
        role: 'assistant',
        id: 'asst-1' as never,
        source: { kind: 'model', provider: 'opencode-go', model: 'zz-cheap' },
        content: [{ type: 'image', attachment: { attachmentId: 'a1' } } as never],
      }],
    }))).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  })
})
