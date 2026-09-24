# 验证：pi-ai 最新版是否已内置会话头，我们能否升级

验证日期：2026-09-24。方法：npm registry 元数据 + unpkg 上已发布产物的原始片段 + 本机 DSH 检出（`D:\git\deepseek-harness`，0.1.7-rc.1）与插件检出（`D:\git\dsh-opencode-go`）交叉核对。所有结论都能用文中 URL 复现。

## 1. 最新版与它带了什么

`@earendil-works/pi-ai` 的 `dist-tags.latest` = **0.87.1**（发布于 2026-09-22T19:38:28Z）。近期版本：0.85.1（09-05）、0.86.0（09-19）、0.86.1（09-20）、0.87.0（09-21）、0.87.1（09-22）。

`dist/providers/opencode-headers.js` 确实存在并导出包装器：

```js
const OPENCODE_SESSION_HEADER = "x-opencode-session";
function hasHeader(headers, name) { /* 大小写不敏感 */ }
function withSessionHeader(options) {
    if (!options?.sessionId || hasHeader(options.headers, OPENCODE_SESSION_HEADER)) return options;
    return { ...options, headers: { ...options.headers, [OPENCODE_SESSION_HEADER]: options.sessionId } };
}
export function withOpenCodeSessionHeader(streams) {
    return { ...streams,
        stream: (model, context, options) => streams.stream(model, context, withSessionHeader(options)),
        streamSimple: (model, context, options) => streams.streamSimple(model, context, withSessionHeader(options)) };
}
```

`dist/providers/opencode-go.js` 把三个 API 全部包上：`anthropic-messages`、`openai-completions`、`openai-responses`；`dist/providers/opencode.js`（Zen）额外包了 `google-generative-ai`。

**对我们的适用性**：只对"由 `opencodeGoProvider()` 构造的 provider"生效。本插件与 DSH 都用裸工厂 `openAICompletionsApi()` / `anthropicMessagesApi()` / `openAIResponsesApi()` 自建 provider，因此**不自动生效**。另外它只在 `sessionId` 存在时注入，没有兜底值。

**可导入性**：包根 `dist/index.d.ts` 不含该符号，但 `package.json` 的 `exports` 有 `"./providers/*"`，故 `@earendil-works/pi-ai/providers/opencode-headers` 可用（子路径属公开面）。

## 2. 目录与兼容面

- 0.85.1 的 `opencode-go` 目录：27 个模型（`anthropic-messages` 2 / `openai-completions` 21 / `openai-responses` 4）。
- 0.87.1：**30 个**（2 / 23 / 5），新增 `deepseek-v4.1-flash`、`mimo-v2.6-flash`、`mimo-v2.6-pro`、`grok-4.7`；`deepseek-v4.1-flash` 自带 `thinkingFormat: deepseek` 与 `requiresReasoningContentOnAssistantMessages`。
- 网关 `https://opencode.ai/zen/go/v1/models` 当前公布 **42** 个 ID，只含 `{id, object, created, owned_by}`，无协议/能力字段。
- 因此即使升到 0.87.1，仍有 12 个网关模型没有任何协议元数据：`minimax-m2.5`、`kimi-k2.5`、`glm-5`、`deepseek-flash`、`qwen3.5-plus`、`mimo-v2-pro`、`mimo-v2-omni`、`space-bunny-free`、`hy3-preview`、`grok-4.5`、`omen-alpha`、`gpt-6-luna`（其中多数在 models.dev 标 `status: deprecated`）。
- 我们用到的 pi-ai 符号在 0.85.1 与 0.87.1 均存在且签名未变：`createProvider`、`getSupportedThinkingLevels`、`isContextOverflow`、`Models`、`MutableModels`、`Provider`、`Model`、`Api`、`ModelThinkingLevel`、`ThinkingLevel`、`SimpleStreamOptions`、`AuthContext`、`CredentialStore`、`streamSimple`、`calculateCost`；`providers/all` 的导出列表逐行一致；`dist/api/{anthropic-messages,openai-completions,openai-responses}.lazy.js`、`dist/providers/opencode-go.models.js`、`dist/utils/json-parse.js` 全部 HTTP 200。

## 3. 升级的代价

DSH 对 0.85.1 打了私有补丁 `patches/@earendil-works__pi-ai@0.85.1.patch`，在 5 个 API 文件里删除 delta 路径上的增量 JSON 解析（`block.arguments = parseStreamingJson(block.partialJson)`，涉及 anthropic-messages、bedrock-converse-stream、mistral-conversations、openai-completions、openai-responses-shared、pi-messages）。实测 0.87.1 中这些调用仍在（`openai-completions.js` 3 处、`anthropic-messages.js` 3 处、`openai-responses-shared.js` 4 处）。升到 0.87.1 而不移植该补丁，等于恢复"流式工具调用时对递增 JSON 反复全量解析"的开销；正确性不受影响。

## 4. DSH 核心为什么不作为路径

- `packages/llm/llm-pi-ai/package.json` 钉 `@earendil-works/pi-ai: ^0.85.1`；`pnpm-workspace.yaml` 另有 `allowBuilds` 与 `patchedDependencies` 针对 0.85.1，换版本要连带重做。
- `packages/llm/llm-pi-ai/src/catalog.ts` 的 `COMPAT_GATES` 在三个族里把 `sendSessionAffinityHeaders`（:255、:282）与 `sessionAffinityFormat`（:257、:266）标为 `withhold`。
- 即使 pin 放宽，设了 `api:` 或手写 `models` 列表的路由仍由 DSH 用裸工厂构造，拿不到 pi-ai 的包装器。
- npm 上 `@deepseek-ai/dsh-llm-pi-ai` 的 `latest` 标签是 `0.0.1-rc.1`（`next` 才是 `0.1.7-rc.1`），发布通道本身也不适合作为交付依赖。

## 5. 结论

插件可以升到 0.87.1，且 API 面无破坏；但会话头仍应由插件自己注入（我们才有"无会话 ID 时兜底"与"同一会话值稳定"的可断言语义），pi-ai 的包装器只作为可选加固（调用方已自带该头时它不会覆盖）。DSH 核心的 pin、补丁与 compat 门禁都不在本次交付路径上。
