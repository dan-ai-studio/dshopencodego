# 0007. 显式声明传递 peer 的四个 devDependency

## Status（状态）

Accepted（2026-10-18 记录，`package.json` 的现状即此决策）。

## Context（背景）

`package.json` 的 `devDependencies` 里有四个包在 `src/` 与 `tests/` 中**零引用**。它们既不是本插件 import 的对象，也不是本插件在 `peerDependencies` 里声明的 peer，因此在代码里"看起来像死依赖"：

| 包 | 谁需要它 | 在本依赖闭包中的位置 |
| --- | --- | --- |
| `@deepseek-ai/dsh-sandbox` | `@deepseek-ai/dsh-fs` 的 peer | 直接 peer `dsh-fs` 的传递 peer |
| `@deepseek-ai/dsh-scope` | `@deepseek-ai/dsh-api-remotes` 的 peer（`@deepseek-ai/dsh-session` 亦然） | 直接 peer `dsh-api-remotes` 的传递 peer |
| `@deepseek-ai/dsh-session` | `@deepseek-ai/dsh-sandbox` 的 peer | 由 `dsh-sandbox` 引入的第二层 |
| `@deepseek-ai/dsh-settings` | 本 profile 的安装树里没有依赖方 | 曾是本插件 `peerDependencies` 的成员，被 `tests/peer-coverage.spec.ts` 以"声明了却没人用"移除 |

## Decision（决策）

这四个包作为 **devDependency 显式声明**，并跟随其余 `@deepseek-ai/dsh-*` 的同一个 rc 版本，而不是让包管理器从传递 peer 里解析它们的版本。

理由：本插件的运行时代码只耦合在直接 peer 上，但一条 peer 链（`dsh-fs` → `dsh-sandbox` → `dsh-session`、`dsh-api-remotes` → `dsh-scope`）决定了实际装进 profile 的运行时。显式钉住它们，升级 DSH 基线时整族一起动，不会出现"直接 peer 已是 `rc.2`、传递 peer 还停在 `rc.1`"的混装。

它们**不参与 DSH 的加载门禁**：门禁读的是 `engines.dsh`（声明了它即单独决定），没有它时才回退到 `peerDependencies` 范围；这四个都不在 `peerDependencies` 里。

## Evidence（实测证据）

- `git grep "@deepseek-ai/dsh-sandbox\|dsh-scope\|dsh-session\|dsh-settings" -- src tests` → **0 命中**。
- 依赖方扫描（遍历 `node_modules/@deepseek-ai/*/package.json` 的 `peerDependencies` 与 `dependencies`）：
  - `dsh-sandbox` ← `dsh-fs`
  - `dsh-scope` ← `dsh-api-remotes`、`dsh-session`
  - `dsh-session` ← `dsh-sandbox`、`dsh-settings`
  - `dsh-settings` ← **无命中**。harness 源码里它是 `dsh-api-session-controller`、`dsh-api-settings-controller`、`dsh-plugin-market`、`dsh-speech-to-text`、`dsh-agent-preset-registry` 的 peer，但这五个包都不在本插件的依赖闭包内。

## Consequences（后果与影响）

- 三个传递 peer 的版本不再由包管理器的传递解析决定；升级 DSH 基线时，直接 peer 与传递 peer 在同一处一起改。
- 代价：`package.json` 里有四个"没有任何 import"的 devDependency，容易被误判为死依赖而删除。本 ADR 就是它们的固定说明；`dsh-settings` 在本 profile 无依赖方这一事实也记录在此，未来的复核要动它时，应先更新本文档而不是静默删除。
- 它们不进入运行时产物：既没有被 import，也不在 `peerDependencies` 中，因此不影响 `lib/` 的内容与包的分发清单。
