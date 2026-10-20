# 文档索引

本目录是 `@dan-ai-studio/dshopencodego` 的项目文档。**除 `adr/` 外的说明文字全部为中文**；英文读者请以根目录的 `README.en.md` 为入口（英文材料只有那一份）。

## 现状（仍然有效，描述当前行为）

| 文档 | 内容 |
| --- | --- |
| [`../README.md`](../README.md) / [`../README.en.md`](../README.en.md) | 面向使用者的权威文档：安装、配置、兼容性、故障排查。**版本号、peer 数与测试文件数以仓库为准**（`tests/readme-consistency.spec.ts` 逐条守护） |
| [`../CONTEXT.md`](../CONTEXT.md) | 名词表：只定义语言，不含实现决策 |
| [`adr/`](adr/) | 架构决策记录（ADR），一条决策一份文件；见下表 |
| [`verification-log.md`](verification-log.md) | 实机 / 真实网关验证记录，按时间倒序；每节末尾如实标注"未覆盖" |

## 评估与建议

| 文档 | 内容 |
| --- | --- |
| [`scope-review-2026-10.md`](scope-review-2026-10.md) | 插件存在必要性评估与职责收缩建议（2026-10-20）。复核两条原始存在理由：会话头已被 pi-ai 上游覆盖（commit `561a2e06`，2026-09-09），实时目录仍是缺口；给出四条建议与三项未核实项。**状态：未执行**，不描述当前行为 |

## 架构决策记录（ADR）

ADR 记录"当时为什么这样决定"。被后续事实或决策取代的部分，会在文件内以 `## Status` 的修订说明或 `## 修订（日期）` 段落标注，**不静默改写历史**。

| ADR | 决策 | 状态 |
| --- | --- | --- |
| [0001](adr/0001-rewrite-from-scratch.md) | 从零重写，而不是迭代已发布的 v0.1.13 | Accepted |
| [0002](adr/0002-pi-ai-as-protocol-engine.md) | 线协议由插件自带的 pi-ai 副本执行 | Accepted（已修订版本号） |
| [0003](adr/0003-keep-opencode-go-route.md) | 路由 id 沿用 `opencode-go` | Accepted |
| [0004](adr/0004-catalog-precedence.md) | 目录与协议判定的四级优先级阶梯 | Accepted（已修订家族规则） |
| [0005](adr/0005-drop-pi-ai-patch.md) | 不移植 pi-ai 的增量解析补丁 | Accepted |
| [0006](adr/0006-endpoint-migration-to-inference.md) | 默认网关端点迁移到 `/inference/go/v1` | Accepted（v0.1.22 落地） |
| [0007](adr/0007-explicit-transitive-peers.md) | 显式声明四个传递 peer 作为 devDependency | Accepted |

## 历史（已归档，不代表现状）

[`archive/`](archive/) 下是 DSH `0.2.1-alpha.3` 适配那一轮的阶段文档，**工作已全部完成**（收尾版本 v0.1.43）。它们保留的是"当时怎么判断、怎么验收"，不是当前行为——判断现状请回到上面的 README、`CONTEXT.md` 与 ADR。

| 文档 | 内容 | 状态 |
| --- | --- | --- |
| [implementation-plan-0.2.1-alpha.3.md](archive/implementation-plan-0.2.1-alpha.3.md) | 实施计划（M1–M4） | 已完成并归档 |
| [requirements-0.2.1-alpha.3.md](archive/requirements-0.2.1-alpha.3.md) | 需求规范（R-A/B/C 编号在此定义） | 已完成并归档 |
| [plan-0.2.1-alpha.3.md](archive/plan-0.2.1-alpha.3.md) | 技术设计与阶段划分 | 已完成并归档 |
| [tasks-0.2.1-alpha.3.md](archive/tasks-0.2.1-alpha.3.md) | 任务清单与状态跟踪（T-01–T-31） | 已完成并归档（T-23 仍 `pending`） |

其余历史材料未归档，因为它们仍被现行文档引用：

| 文档 | 内容 |
| --- | --- |
| [plan.md](plan.md) | 建仓计划（v0.1.x 至 M6）；M1–M6 判据已达成 |
| [comparison-v0.1.13.md](comparison-v0.1.13.md) | 与旧插件 `@dan-ai-studio/dsh-opencode-go@0.1.13` 的机制对比 |
| [runbook-m5-live-verification.md](runbook-m5-live-verification.md) | M5 浏览器实测的操作手册 |
| [verification-0.2.1-live.md](verification-0.2.1-live.md) | 0.2.1 适配实机验证的操作手册（**尚未执行**：文件内没有回写的实际结果） |

## 为什么有些历史文档引用的证据打不开：`scratch/`

`scratch/` 被 `.gitignore` 忽略（`git ls-files scratch` 返回 0），**从未入库、不随仓库分发**。历史文档里大量 `scratch/…` 引用是本机一次性的验证产物（抓包、原始日志、依赖备份），克隆者**无法核对、也无法复现**——重跑需要真实网关、真实凭证与相同的时间点。

本仓库不再把这类产物当作可交付证据：要留下结论，就把可复现的部分写进受版本控制的文档（例如 `verification-log.md`），或按对应 runbook 在本机重跑，并接受"产物仍然不入库"。

> **安全提醒**：`scratch/` 下可能存在含明文 API key 的代理日志（`tools/verify/recording-proxy.mjs` 会把请求头原样落盘）。**不要**把 `scratch/` 里的任何文件复制进仓库。
