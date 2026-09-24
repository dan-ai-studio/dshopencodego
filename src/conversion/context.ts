/**
 * Harness request history converted into pi-ai's request vocabulary.
 *
 * Three shapes need care:
 *
 * - The system prompt has one home in pi-ai. `normalizeContext()` folds
 *   `Context.systemPrompt` and `Context.tools` into a leading system message,
 *   so this module only has to decide *which* text that is.
 * - Tool results are their own message role and must carry the tool's *name*,
 *   which the Harness records only on the preceding assistant tool call — so
 *   names are recovered by walking the history.
 * - Images go through the durable attachment service under the route's pixel
 *   and encoded-byte budgets, and follow the host's offload protocol instead of
 *   dropping content locally.
 *
 * The image helpers are reached through a namespace import on purpose: they are
 * newer additions to the LLM seam, and a named import of one that a host build
 * does not export fails at module instantiation — taking the whole plugin down
 * before it can report anything. A namespace read fails only when the feature is
 * actually used.
 *
 * @module @dan-ai-studio/dshopencodego/conversion/context
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import * as llm from '@deepseek-ai/dsh-llm'
import { contentHasImage, LlmError, requestImageHandleText } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  ImageAttachmentAccess,
  ImageAttachmentAccessResolver,
  RequestMessage,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import { requestImageDimensions } from '@deepseek-ai/dsh-attachment'
import type { AttachmentId, AttachmentStore, ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { Context as PiContext, ImageContent, Message as PiMessage, TextContent, Tool as PiTool } from '@earendil-works/pi-ai'
import { toPiAssistant } from './replay.ts'

/** Join the text blocks of one Harness message. */
function flattenText(message: RequestMessage): string {
  return message.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

interface ToolMessage {
  toolCallId: ToolCallId
  content: readonly ContentBlock[]
  isError?: boolean
}

/** DSH 0.1.7 carries tool results under their own role. */
function toolMessage(message: RequestMessage): ToolMessage | undefined {
  return (message as { role: string }).role === 'tool' ? message as unknown as ToolMessage : undefined
}

/** pi-ai cannot replay an image attached to an assistant or system message. */
function assertSupportedImageRoles(messages: readonly RequestMessage[]): void {
  for (const message of messages) {
    if (message.role !== 'user' && toolMessage(message) === undefined && contentHasImage(message.content)) {
      throw new LlmError(`pi-ai cannot represent an image in an in-history ${message.role} message`, 'UNSUPPORTED_CONTENT')
    }
  }
}

function toolsOf(options: GenerateOptions): PiTool[] | undefined {
  return options.tools?.map(tool => ({
    name: tool.name,
    description: tool.description,
    // ToolSchema.parameters is a JSON Schema object; pi-ai's TSchema is
    // structurally JSON Schema, so it assigns directly.
    parameters: tool.parameters,
  }))
}

/** The request split into pi-ai's system slot and the converted history. */
interface SystemPromptSplit {
  systemPrompt: string | undefined
  messages: readonly RequestMessage[]
}

/**
 * Select the system prompt for pi-ai.
 *
 * `options.system` wins when defined; otherwise a leading `system` message
 * supplies it and leaves the converted history. An empty leading message sends
 * no prompt at all.
 */
function splitSystemPrompt(options: GenerateOptions): SystemPromptSplit {
  if (options.system !== undefined) return { systemPrompt: options.system, messages: options.messages }
  const [first, ...rest] = options.messages
  if (first?.role !== 'system') return { systemPrompt: undefined, messages: options.messages }
  const text = flattenText(first)
  return { systemPrompt: text.length > 0 ? text : undefined, messages: rest }
}

/** Image inputs that bind one request's attachments to the current tool world. */
export interface PiImageRequestContext {
  /** Durable provider resolving request-image bytes. */
  readonly attachments: AttachmentStore
  /** Resolve current tool access separately from deterministic request images. */
  readonly resolveImageAccess: ImageAttachmentAccessResolver
  /** Request-level bound on the base64 payload of retained images. */
  readonly maxRequestImageBytes?: number
  /** Route pixel and encoded-byte budgets. */
  readonly requestImagePolicy?: { readonly maxPixels: number; readonly maxBytes: number }
}

/** Every image occurrence this request will actually send. */
function collectImageRefs(blocks: readonly ContentBlock[], refs: Map<AttachmentId, ImageAttachmentRef>): void {
  for (const block of blocks) {
    // An occurrence the surface already offloaded is a placeholder, not an image.
    if (block.type === 'image' && block.offloaded !== true) refs.set(block.attachment.attachmentId, block.attachment)
  }
}

async function prepareRequestImages(
  messages: readonly RequestMessage[],
  attachments: AttachmentStore,
  policy: { maxPixels: number; maxBytes: number },
  signal?: AbortSignal,
): Promise<Map<AttachmentId, RequestImageAttachment>> {
  const refs = new Map<AttachmentId, ImageAttachmentRef>()
  for (const message of messages) collectImageRefs(message.content, refs)
  const ordered = [...refs.values()]
  const prepared = await Promise.all(ordered.map(ref => attachments.readImageRequest(
    ref,
    { ...requestImageDimensions(ref.width, ref.height, policy.maxPixels), maxBytes: policy.maxBytes },
    signal,
  )))
  const versions = new Map<AttachmentId, RequestImageAttachment>()
  for (const [index, ref] of ordered.entries()) versions.set(ref.attachmentId, prepared[index] as RequestImageAttachment)
  return versions
}

/** Convert one message's content into pi-ai user content. */
async function userContent(
  blocks: readonly ContentBlock[],
  requestImages: ReadonlyMap<AttachmentId, RequestImageAttachment>,
  resolveImageAccess: ImageAttachmentAccessResolver,
): Promise<string | (TextContent | ImageContent)[]> {
  const content: (TextContent | ImageContent)[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text.length > 0) content.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type === 'image') {
      const version = requestImages.get(block.attachment.attachmentId) as RequestImageAttachment
      content.push({
        type: 'text',
        text: requestImageHandleText(block.attachment, version, resolveImageAccess(block.attachment)),
      })
      content.push({ type: 'image', data: Buffer.from(version.data).toString('base64'), mimeType: version.mediaType })
    }
    // Other block types are not user-input vocabulary for pi-ai.
  }
  return content.every(block => block.type === 'text')
    ? content.map(block => block.text).join('')
    : content
}

/**
 * Apply the host's image offload protocol to a request history.
 *
 * The host marks what the surface already offloaded. When the retained
 * occurrences still exceed the base64 bound, the request fails with
 * `IMAGE_OFFLOAD_REQUIRED` naming how many more must go — the host's retry
 * protocol, not a local decision to drop content.
 */
function projectImagesForRequest(
  messages: readonly RequestMessage[],
  images: PiImageRequestContext,
  requestImages: ReadonlyMap<AttachmentId, RequestImageAttachment>,
): readonly RequestMessage[] {
  const offloadedImageText = llm.offloadedImageText
  const placeholder = (ref: ImageAttachmentRef): string =>
    offloadedImageText(ref, images.resolveImageAccess(ref) as ImageAttachmentAccess | undefined)
  if (images.maxRequestImageBytes !== undefined) {
    const over = llm.requiredImageOffload(
      messages,
      { representation: 'base64', maxBytes: images.maxRequestImageBytes, byteQuantum: 1 },
      block => (requestImages.get(block.attachment.attachmentId) as RequestImageAttachment).bytes,
    )
    if (over > 0) {
      throw new LlmError(
        `request images exceed the ${images.maxRequestImageBytes}-byte base64 bound;`
        + ` ${over} more oldest occurrence(s) must be offloaded`,
        llm.IMAGE_OFFLOAD_REQUIRED_CODE,
        { offloadImages: over },
      )
    }
  }
  return llm.projectOffloadedImages(messages, placeholder)
}

/**
 * Convert Harness history into a pi-ai request context.
 *
 * The result is a plain `Context`; the adapter normalizes it into the branded
 * transcript pi-ai's providers accept.
 * @param options - the assembled request.
 * @param images - attachment access; omitted selects the text-only conversion,
 *   which refuses any image rather than silently dropping it.
 * @param onReplayDegrade - called when stored replay metadata is unusable.
 * @returns the pi-ai context.
 * @throws {LlmError} `UNSUPPORTED_CONTENT` for an image this request cannot
 *   carry, and `IMAGE_OFFLOAD_REQUIRED` when retained images still exceed the
 *   base64 bound.
 */
export async function toPiContext(
  options: GenerateOptions,
  images?: PiImageRequestContext,
  onReplayDegrade?: (reason: string) => void,
): Promise<PiContext> {
  assertSupportedImageRoles(options.messages)
  const split = splitSystemPrompt(options)
  const resolveImageAccess: ImageAttachmentAccessResolver = images?.resolveImageAccess ?? (() => undefined)
  const policy = images?.requestImagePolicy ?? { maxPixels: 1_440_000, maxBytes: 400_000 }
  const requestImages = images === undefined
    ? new Map<AttachmentId, RequestImageAttachment>()
    : await prepareRequestImages(split.messages, images.attachments, policy, options.signal)
  const history = images === undefined
    ? split.messages
    : projectImagesForRequest(split.messages, images, requestImages)

  const toolNames = new Map<ToolCallId, string>()
  const messages: PiMessage[] = []
  for (const message of history) {
    const tool = toolMessage(message)
    if (tool !== undefined) {
      const content = await userContent(tool.content, requestImages, resolveImageAccess)
      messages.push({
        role: 'toolResult',
        toolCallId: tool.toolCallId,
        toolName: toolNames.get(tool.toolCallId) ?? 'unknown',
        content: typeof content === 'string'
          ? [{ type: 'text', text: content.length > 0 ? content : '(no output)' }]
          : content,
        isError: tool.isError ?? false,
        timestamp: 0,
      })
      continue
    }
    if (message.role === 'system') {
      // pi-ai keeps one leading system message; a later one folds into a user
      // message so its position in the history survives.
      messages.push({ role: 'user', content: flattenText(message), timestamp: 0 })
      continue
    }
    if (message.role === 'assistant') {
      const assistant = toPiAssistant(message, onReplayDegrade)
      for (const block of assistant.content) {
        if (block.type === 'toolCall') toolNames.set(brandString<ToolCallId>(block.id), block.name)
      }
      messages.push(assistant)
      continue
    }
    const content = await userContent(message.content, requestImages, resolveImageAccess)
    messages.push({ role: 'user', content, timestamp: 0 })
  }

  const tools = toolsOf(options)
  return {
    ...split.systemPrompt === undefined ? {} : { systemPrompt: split.systemPrompt },
    messages,
    ...tools === undefined || tools.length === 0 ? {} : { tools },
  }
}
