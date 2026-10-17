# 0004. 目录与协议判定的优先级阶梯

## Status（状态）

Accepted。**已修订（2026-10-18）**：第 3 级家族规则原写有 `qwen* → anthropic-messages`，代码中从未存在该分支，见文末「修订」。标题按 ADR 序列补上编号。

## Context（背景）

一个模型"怎么调"必须由一个确定来源回答，而网关的 `/v1/models` 只回答"有哪些模型"（`{id, object, created, owned_by}`），不回答协议。可选来源有四个：本插件自带的 pi-ai 目录、models.dev 的每模型 `provider.npm`、按 id 前缀猜的家族规则、以及用户配置里的显式覆盖。

## Decision（决策）

一个模型"怎么调"由四级证据决定，先命中先赢：

1. **pi-ai 内置目录的精确条目**（`getBuiltinModels('opencode-go')`）：给出线协议、`baseUrl`、上下文与输出上限，以及 DeepSeek 系必需的 `thinkingFormat`/`requiresReasoningContentOnAssistantMessages` compat。
2. **models.dev 的每模型 `provider.npm`**：`@ai-sdk/openai` → `openai-responses`，`@ai-sdk/anthropic` → `anthropic-messages`，缺省（即 provider 级 `@ai-sdk/openai-compatible`）→ `openai-completions`；同源还提供 `status: deprecated`、`limit`、`modalities`、`cost`、`reasoning`。
3. **家族启发式**：`grok*`/`gpt*`/`muse-*` → `openai-responses`，其余（**含 `qwen*`、`minimax*`**）→ `openai-completions`；判定结果在 UI 标为"推断"。
4. **配置里的逐模型覆盖**：永远最高优先，用于启发式猜错的兜底。

网关的 `/v1/models` 只回答"有哪些模型"，不回答"怎么调"，因此它只负责可用性，不参与协议判定。

考虑过并否决：运行时探测（对新模型依次试三种协议直到成功）——会产生真实计费调用与额外延迟，且错误协议不保证报错；运行时从 CDN 拉 pi-ai 目录 JSON——多一层第三方依赖，仍慢于网关。

## Consequences（后果与影响）

网关新增、且四级证据都没有的模型，会以"配置缺失"出现（开关关闭、不可选、直接调用时说明原因），而不是被静默当作某个协议发出去。

## 修订（2026-10-18）：删除不曾存在的 `qwen*` 分支

本文档原先在第 3 级写有「`qwen*` → `anthropic-messages`」。**该分支在代码里从未存在**，保留原文会误导读者：

- `src/catalog/protocol.ts` 的 `RESPONSES_FAMILIES` 只有 `['grok', 'gpt', 'muse']`；`inferProtocol()` 只做「命中三个前缀 → `openai-responses`，否则 → `openai-completions`」，没有 `qwen` 分支。
- 同文件紧邻 `RESPONSES_FAMILIES` 的注释解释了**为什么故意不加 Qwen/MiniMax**：内置目录把 `qwen3.8-flash` 与 `minimax-m3` 放在 Anthropic Messages，却把 `qwen3.6-plus`、`qwen3.7-*`、`qwen3.8-max`、`minimax-m2.7` 放在 Chat Completions —— 一个家族规则"would be wrong about half of them"。
- `README.md` 与 `README.en.md` 的家族规则描述自始与代码一致（只列 `grok*`/`gpt*`/`muse-*`），只有本 ADR 写多了一条。

上面 Decision 段已按代码实际行为改写；`qwen*`/`minimax*` 的协议仍由第 1、2 级证据决定，猜错时用第 4 级 `modelProtocols` 覆盖。
