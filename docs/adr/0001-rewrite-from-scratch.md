# 0001. 从零重写，而不是迭代已发布的 v0.1.13

## Status（状态）

Accepted（已执行）。本 ADR 里的"新插件"即当前仓库 `@dan-ai-studio/dshopencodego`；v0.1.13 所在的 `@dan-ai-studio/dsh-opencode-go` 已停更。

## Context（背景）

`@dan-ai-studio/dsh-opencode-go` v0.1.13 已在 `web` profile 中可用，并已实现三项能力（自有 `opencode-go` 路由、网关+在线元数据的实时目录、`x-opencode-session`）。继续迭代它的前提是接受它的结构假设。

## Decision（决策）

在新工作区从零重写，而不是继续迭代它，因为要改的四件事都落在它的结构假设上：

1. 依赖内嵌 pi-ai 的私有副本；
2. 70KB 单文件 Host 产物；
3. 只能从 GitHub Release tarball 分发；
4. "配置缺失即禁用"的目录策略。

在原结构上改这四项等于重写，却要一直背着旧结构的兼容包袱。

考虑过并否决的替代方案：直接给 v0.1.13 打补丁（改动小，但无法同时满足依赖可控、可测试与自主分发）；上游改 DSH 的 `llm-pi-ai`（受 DSH 对外部 PR 的限制，且无法覆盖用量与 UI）。

## Consequences（后果与影响）

- 包名、仓库与工作区都是新的；旧插件不会被原地改造成本插件。
- 路由 id 仍沿用 `opencode-go`（见 ADR-0003），因此两者在同一 profile 内互斥，安装前必须卸载旧的。
- 代价是重写的一次性成本与两份实现短暂并存；收益是依赖、产物形态、分发与目录策略四项都可自主决定。
