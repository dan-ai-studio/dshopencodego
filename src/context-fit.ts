/**
 * 发送前按上下文窗口装配一次请求。
 *
 * 宿主拥有压缩会话的职责，插件拥有不上报谎言的职责：网关按
 * `input + max_tokens <= contextWindow` 做严格校验（`muse-spark`
 * 系 `1048576 / 131072` 即为一例），而宿主在 `input` 已占 `87%`
 * 时仍可能按满额输出请求。本模块在发网关之前做两件事：
 *
 * - 输入本身已超窗：直接抛 `CONTEXT_WINDOW_EXCEEDED`，让宿主走压缩/
 *   重试分支，而不是等网关 `400 context_length_exceeded` 再失败；
 * - 输入加请求输出会超窗：把本次 `maxTokens` 收缩到剩余窗口内。
 *   收缩是保底成功，不是替代压缩：历史照旧原样发送，不截断、不总结。
 *
 * 估算是有意保守的上界：网关分词器未知，按 `3 字符 ≈ 1 token`
 * 加固定开销估算，多估只会多收一点输出，不会把能过的请求误杀。
 * 图片/文件按固定开销加字节折算，视觉 token 的真实计费未知时宁可高估。
 *
 * @module @dan-ai-studio/dshopencodego/context-fit
 */

import { CONTEXT_WINDOW_EXCEEDED_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

/** 为分词器漂移和线上传输开销预留的窗口。 */
export const CONTEXT_FIT_RESERVE_TOKENS = 2048

/** 收缩后仍值得发一次请求的最小输出。低于它就直接失败，逼宿主压缩。 */
export const CONTEXT_FIT_MIN_OUTPUT_TOKENS = 256

/** 保守估算：几个字符算一个 token。 */
const CHARS_PER_TOKEN = 3

/** 每条消息的角色/边界开销。 */
const TOKENS_PER_MESSAGE = 8

/** 每个未卸载图片的固定开销（补丁/占位符），字节部分另算。 */
const TOKENS_PER_IMAGE = 2000

/** 图片字节折算：`bytes / 2000` tokens。 */
const IMAGE_BYTES_PER_TOKEN = 2000

/** 每个文件引用的固定开销（句柄文本），字节部分另算。 */
const TOKENS_PER_FILE = 500

/** 文件字节折算：`bytes / 4000` tokens。 */
const FILE_BYTES_PER_TOKEN = 4000

/** 估算所需的请求子集：只读文本与附件元数据，不读字节。 */
export interface FittableRequest {
  readonly messages: GenerateOptions['messages']
  readonly system?: GenerateOptions['system']
  readonly tools?: GenerateOptions['tools']
}

/**
 * 保守估算一次请求的输入 token 数（上界，非精确计数）。
 * @param options - 本次请求的消息、系统提示与工具声明。
 * @returns 估算的输入 token 数，至少为 0 的有限整数。
 */
export function estimateInputTokens(options: FittableRequest): number {
  let chars = 0
  let images = 0
  let imageBytes = 0
  let files = 0
  let fileBytes = 0
  if (typeof options.system === 'string') chars += options.system.length
  for (const message of options.messages) {
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
        case 'reasoning':
          chars += block.text.length
          break
        case 'tool-call':
          chars += block.name.length + block.arguments.length
          break
        case 'image':
          if (block.offloaded === true) {
            // 已卸载的以占位文本发送，按一段短文本估算。
            chars += 200
          } else {
            images += 1
            imageBytes += block.attachment.bytes
          }
          break
        case 'file':
          files += 1
          fileBytes += block.attachment.bytes
          chars += block.attachment.name.length
          break
        default:
          break
      }
    }
  }
  if (options.tools !== undefined && options.tools.length > 0) {
    // 工具声明每次全量发送：序列化一次，只为量长度。
    chars += JSON.stringify(options.tools).length
  }
  const estimate = Math.ceil(chars / CHARS_PER_TOKEN)
    + options.messages.length * TOKENS_PER_MESSAGE
    + images * TOKENS_PER_IMAGE + Math.ceil(imageBytes / IMAGE_BYTES_PER_TOKEN)
    + files * TOKENS_PER_FILE + Math.ceil(fileBytes / FILE_BYTES_PER_TOKEN)
  return Number.isFinite(estimate) && estimate > 0 ? Math.floor(estimate) : 0
}

/** `resolveFittedMaxTokens` 的输入。 */
export interface FitRequest {
  /** 展示给宿主看的模型 id，只用于报错文本。 */
  readonly modelId: string
  /** 该模型的上下文窗口（含本次已应用的覆盖）。 */
  readonly contextWindow: number
  /** 路由自身的输出上限（含覆盖），未知时传 undefined。 */
  readonly routeMaxTokens?: number | undefined
  /** 调用方本次请求的输出上限，未指定时传 undefined。 */
  readonly requestedMaxTokens?: number | undefined
  /** `estimateInputTokens` 的输出。 */
  readonly estimatedInputTokens: number
}

/**
 * 按剩余窗口装配本次的 `maxTokens`。
 * @param fit - 窗口、路由上限、调用方请求与输入估算。
 * @returns 发往网关的 `maxTokens`：不需要收缩时与调用方请求一致
 *   （调用方未指定则保持 `undefined`，不断言网关默认值）。
 * @throws {LlmError} `CONTEXT_WINDOW_EXCEEDED`：输入本身已超窗，或剩余
 *   窗口连最小输出都放不下。调用方应据此走压缩/截断分支。
 */
export function resolveFittedMaxTokens(fit: FitRequest): number | undefined {
  const { modelId, contextWindow, routeMaxTokens, requestedMaxTokens, estimatedInputTokens } = fit
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return requestedMaxTokens
  const input = Number.isFinite(estimatedInputTokens) && estimatedInputTokens > 0 ? Math.floor(estimatedInputTokens) : 0
  const allowed = Math.floor(contextWindow - input - CONTEXT_FIT_RESERVE_TOKENS)
  const over = (what: string): LlmError => new LlmError(
    `opencode-go model "${modelId}" ${what} (~${input} input tokens) leaves no room inside context window ${contextWindow}`
    + ` (reserve ${CONTEXT_FIT_RESERVE_TOKENS}); compact the conversation or lower maxTokens`,
    CONTEXT_WINDOW_EXCEEDED_CODE,
  )
  // 输入本身已把窗口（含最小输出）吃满：发出去一定是网关 400，提前失败。
  if (allowed < CONTEXT_FIT_MIN_OUTPUT_TOKENS) throw over('input')
  // 调用方与路由都没点名输出：不断言网关默认值，原样不带 maxTokens 发送。
  const effective = requestedMaxTokens ?? routeMaxTokens
  if (effective === undefined) return undefined
  if (!Number.isFinite(effective) || effective <= 0) return requestedMaxTokens
  if (effective <= allowed) return requestedMaxTokens
  // 输入加请求输出会超窗：收缩到剩余窗口。调用方未点名但路由有点名时，
  // 收缩的是路由上限，返回显式数值，避免网关按满额默认值执行。
  return allowed
}
