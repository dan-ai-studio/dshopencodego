# 目录与协议判定的优先级阶梯

一个模型"怎么调"由四级证据决定，先命中先赢：

1. **pi-ai 内置目录的精确条目**（`getBuiltinModels('opencode-go')`）：给出线协议、`baseUrl`、上下文与输出上限，以及 DeepSeek 系必需的 `thinkingFormat`/`requiresReasoningContentOnAssistantMessages` compat。
2. **models.dev 的每模型 `provider.npm`**：`@ai-sdk/openai` → `openai-responses`，`@ai-sdk/anthropic` → `anthropic-messages`，缺省（即 provider 级 `@ai-sdk/openai-compatible`）→ `openai-completions`；同源还提供 `status: deprecated`、`limit`、`modalities`、`cost`、`reasoning`。
3. **家族启发式**：`grok*`/`gpt*`/`muse-*` → `openai-responses`，`qwen*` → `anthropic-messages`，其余 → `openai-completions`；判定结果在 UI 标为"推断"。
4. **配置里的逐模型覆盖**：永远最高优先，用于启发式猜错的兜底。

网关的 `/v1/models` 只回答"有哪些模型"（`{id, object, created, owned_by}`），不回答"怎么调"，因此它只负责可用性，不参与协议判定。

考虑过并否决：运行时探测（对新模型依次试三种协议直到成功）——会产生真实计费调用与额外延迟，且错误协议不保证报错；运行时从 CDN 拉 pi-ai 目录 JSON——多一层第三方依赖，仍慢于网关。

后果：网关新增、且四级证据都没有的模型，会以"配置缺失"出现（开关关闭、不可选、直接调用时说明原因），而不是被静默当作某个协议发出去。
