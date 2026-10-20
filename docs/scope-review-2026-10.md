# 插件存在必要性评估与职责收缩建议

> **状态：评估与建议，未执行。** 本文不改变任何运行时行为。文中每条结论都标注了证据位置；未经实机复现的部分集中在第 6 节。
>
> 评估日期：2026-10-20。评估对象：`@dan-ai-studio/dshopencodego` v0.1.45（commit `619166e`）。对照物：DeepSeek Harness `0.2.1-rc.2`（`D:\git\deepseek-harness`，检出 `687f282e`）与 `@earendil-works/pi-ai` 1.3.0（本机 `node_modules` 实装版本；本文第 6 节第 3 项记录的 1.1.0 基准已按 1.3.0 重算）。
>
> **修订（2026-10-20，第二次复核）**：初稿的对照基准写的是 harness `0.2.1-alpha.5` 与 pi-ai `1.1.0`，两者都与本机实装不符——实装为 harness `0.2.1-rc.2` 与 pi-ai `1.3.0`。文中所有依赖版本的具体数字已按 1.3.0 重算并标注；**结论方向未变**，其中「实时目录仍是缺口」因 1.3.0 的模型表更小而**更强**（缺口由 6 个扩大为 8 个）。
>
> 术语沿用 [`../CONTEXT.md`](../CONTEXT.md)，历史决策沿用 [`adr/`](adr/)。

## 1. 结论

插件仍有存在必要，但它的两条原始存在理由之一已经失效，且当前实现里存在一处与上游重复的实现。建议收缩会话头这一项能力，把该头交还给 pi-ai；目录、路由、用量与界面部分保持现状——它们与 DSH 内置 `llm-pi-ai` 是互补分工，不构成重复（§4.2）。

三条支撑结论：

1. **会话头不再是缺口。** pi-ai 上游已于 2026-09-09（commit `561a2e06`）实现 `x-opencode-session` 的注入，DSH 内置 `llm-pi-ai` 经 `streamSimple` 链路自动生效。插件的 `src/session-header.ts` 是同一能力的第二份实现。
2. **实时目录仍是缺口。** pi-ai 内置的 `opencode-go` 目录是构建期快照（1.3.0 为 29 个模型），网关公布 37 个；快照里没有的 `minimax-m3.1-flash-free`、`beam-free` 只有插件的目录能提供。
3. **插件与 DSH 内置 `llm-pi-ai` 是互补分工，不是替代关系。** 设置页的 provider 配置入口由目录条目承载（`llm-pi-ai` 提供），模型选择器的模型列表由适配器回答（`llm.listModels` → 适配器，插件提供 live catalog）。插件经 `ctx.llm.registerAdapter([PROVIDER_ID], adapter)`（`src/index.ts:196`）持有 `opencode-go` 路由，是 live catalog 出现在模型选择器的唯一途径；同时其目录实现把 `OPENCODE_GO_MODELS` 当作第一级回退与 compat 来源（`src/catalog/index.ts:93-102`），静态快照的模型与 compat 并未丢失。

## 2. 存在理由复核

插件 README（第 9–14 行）给出两条原生 DSH 接 OpenCode Go 的缺口。本节逐条复核。

### 2.1 「没有会话头」——已失效

README 第 12 行的原文是：「`llm-pi-ai` 只发静态 profile headers，无法按会话取值」。这一描述在 pi-ai 当前版本下不成立。

上游修复的引入点：

| 事实 | 证据 |
| --- | --- |
| pi-ai 上游在 2026-09-09 提交 `561a2e06`「fix(ai): send OpenCode session header」，把 `sessionId` 映射为 `x-opencode-session`，覆盖 OpenCode 与 OpenCode Go 两个 provider 的适配器 | `earendil-works/pi` 仓库 commits API（`packages/ai/src/providers/opencode-headers.ts` 路径）；提交说明含 "Closes #9326" |
| 该实现包装了 `stream` **与** `streamSimple` 两个入口 | `pi-ai@1.3.0: dist/providers/opencode-headers.js:15-21` |
| `opencode-go` provider 的四个 api（`anthropic-messages` / `google-generative-ai` / `openai-completions` / `openai-responses`）全部经该包装 | `pi-ai@1.3.0: dist/providers/opencode-go.js`（`withOpenCodeSessionHeader(...)` 包裹四处；1.1.0 时只有三个，尚无 `google-generative-ai`） |
| DSH 的 `llm-pi-ai` 走的正是 `streamSimple`，且传入 `sessionId` | `deepseek-harness: packages/llm/llm-pi-ai/src/adapter.ts:416`（`snapshot.models.streamSimple(...)`）与 `:420`（`sessionId: String(options.sessionId)`） |
| agent-loop 每轮请求都带会话 id | `deepseek-harness: packages/core/agent-loop/src/agent.ts:700`（`sessionId: this.session.id`） |
| DSH 的 `llm-pi-ai` 由 `dsh-base` bundle 自带，且按用户配置的 provider profile 动态注册路由 | `deepseek-harness: packages/bundle/base/package.json`（依赖 `@deepseek-ai/dsh-llm-pi-ai`）与 `packages/bundle/base/cordis.patch.yml` |

结论：卸载插件、在 Web Models 页配置一个 `opencode-go` 的 provider profile，DSH 内置 `llm-pi-ai` 会自动携带 `x-opencode-session`。

**唯一增量差异**：插件在会话 id 缺失时用一次性 UUID 兜底（`src/session-header.ts:51-53`），pi-ai 在缺失时直接不注入该头（`opencode-headers.js:6-8`），而网关会因此返回 `400 MissingSessionID`。DSH 的 agent-loop 始终传入会话 id，该分支在实际链路上不触发。这个差异的价值在于兜底健壮性，属于应当反馈给 pi-ai 的上游改进点，而不是插件自建一份的理由。

**该论断的时间关系**：网关自 2026-09-05 起要求会话头，上游修复落在 2026-09-09，即四天后。插件 README 引用了前者，却未跟踪后者；而插件自己声明的 `pi-ai` devDependency 区间是 `~1.3.0`，该区间必然包含此修复。

### 2.2 「模型列表是构建期快照」——仍成立

| 事实 | 证据 |
| --- | --- |
| pi-ai 的 `opencode-go` 模型表是构建期生成物（`scripts/generate-models.ts`），文件头自带「auto-generated / Do not edit manually」 | `pi-ai@1.3.0: dist/providers/opencode-go.models.js` 的 sourcesContent |
| 该快照在本机版本（1.3.0）中共 29 个模型（`anthropic-messages` 5、`google-generative-ai` 1、`openai-completions` 18、`openai-responses` 5） | `pi-ai@1.3.0: dist/providers/data/opencode-go.json` |
| 网关实际公布 37 个模型 | `adr/0006-endpoint-migration-to-inference.md:23-25`（两端点逐条一致的抓包结论） |
| 快照缺失、而网关提供的模型包括 `minimax-m3.1-flash-free`、`beam-free` | 同上 JSON 与网关列表的差集；本仓库 `src/config.ts` 的 `modelVisibility` 默认值也列出这两项。（初稿列出的 `step-5-preview-free` 在 1.3.0 的快照中**已经存在**，不再属于差集） |

插件的四级优先级阶梯（`src/catalog/index.ts:3-17`：网关 listing → models.dev → pi-ai 内置目录 → provider 官方文档）配合 TTL 缓存、未知 id 强制重验证、多级降级，是构建期快照无法提供的。这是插件当前最硬的价值。

## 3. 职责与生态对照

| 职责 | 代码位置 | pi-ai / DSH 是否已有 | 判定 |
| --- | --- | --- | --- |
| 会话头 `x-opencode-session` | `src/session-header.ts` | 是（`pi-ai@1.3.0: dist/providers/opencode-headers.js`） | 已覆盖，可收缩 |
| 路由适配器（线协议翻译）与模型列表 | `src/adapter.ts`（`listModels` 在 `:236`） | 部分：`llm-pi-ai` 也做 DSH 请求到 pi-ai context 的转换 | 转换层重叠但有增量，见 §4.1；模型列表由适配器回答，是 live catalog 生效的唯一途径，见 §4.2 |
| 实时目录 | `src/catalog/`（8 个文件） | 否 | 保留 |
| 用量窗口（rolling / weekly / monthly） | `src/usage/`、`src/go-limits.ts` | 否 | 保留 |
| 花费估算 | `src/usage/meter.ts` | 否 | 保留 |
| 逐模型开关 `modelVisibility` | `src/models.ts`、`src/config.ts` | 否：`packages/llm` 全包检索 `modelVisibility` / `modelFilter` / `hiddenModels` / `visibility` 零命中 | 保留 |
| 客户端界面 | `src/client/`（`Section.tsx`、`UsagePill.tsx`） | 否 | 保留 |
| 插件自身版本检查 | `src/update/` | 否，但 DSH 插件管理器已有显式更新通道 | 可废弃，见 §5 第 3 条 |

## 4. 两处需要澄清的关系

### 4.1 适配器层与 `llm-pi-ai` 重叠，但保留两处增量

两处适配器都做「DSH 请求 → pi-ai context → 线协议」。插件独有的两件事值得保留：

- **stop 序列的协议路由**（`src/adapter.ts:73-87`）：DSH 的 stop 控制只有 OpenAI 兼容适配器能承载，插件对其它协议抛 `UNSUPPORTED_OPTION`，而不是静默丢弃让调用方误以为生成会在某个字符串处停止。
- **推理 token 的独立计量**（`src/adapter.ts:108-116`）：pi-ai 把推理 token 报为 `output` 的子集，`mapUsage`（`src/conversion/stream.ts`）会丢弃该拆分；插件在转换前从原始流取走，供用量面板单独显示且不计入总量。

### 4.2 路由与目录条目是两条独立通道，插件各取其一

DSH 的 LLM 运行时把「provider 的配置入口」与「provider 的模型列表」交给两套互不相干的机制：

| 关注点 | 承载机制 | 当前由谁提供 |
| --- | --- | --- |
| 设置页的 provider 配置入口（名称、设置路径、端点、认证） | 目录条目 `registerConfigurableProviders`，**按 provider 键唯一** | `llm-pi-ai`（遍历 pi-ai 全部内置 provider id，`llm-pi-ai/src/index.ts:148`） |
| 模型选择器里的模型列表 | `llm.listModels(provider)` → **适配器自己回答**（`llm/src/index.ts:718-720`） | 本插件（`src/adapter.ts:236` 返回 live catalog） |
| 推理路由 | 适配器注册表，`ctx.llm.registerAdapter` | 本插件（`src/index.ts:196`） |

目录条目的唯一性由 `llm/src/index.ts:515-518` 强制：同一 provider 键被他人声明时抛 `DUPLICATE_DIRECTORY`。因此插件与 `llm-pi-ai` 不可能同时声明 `opencode-go` 的目录条目。

v0.1.45 让插件撤回了目录条目注册、保留路由注册，是正确的取舍，不是自伤：

- **撤回目录条目**（v0.1.44 引入、v0.1.45 撤回）——`llm-pi-ai` 注册目录时没有 try/catch，重复声明抛出的 `DUPLICATE_DIRECTORY` 会冒泡出 `apply`，连带 `llm-pi-ai` 服务的所有 provider（`deepseek`、`nvidia` 等）一起失效；而设置页的 `opencode-go` 配置入口由 `llm-pi-ai` 提供本就够用。CHANGELOG 对此的措辞是准确的：「那是**加载顺序的侥幸，不是设计保证**」。
- **保留路由注册**——模型选择器的模型列表由适配器回答，不经目录条目。插件的适配器被选中时，`listModels('opencode-go')` 返回 live catalog 的 37 个模型；若路由归 `llm-pi-ai`，则返回静态快照的 29 个。`llm/src/index.ts:713-714` 的注释明确了这条分界：「Catalog membership does not constrain core routing. Catalog-driven entry points may restrict selection and submission to the advertised models.」

因此本插件与 `llm-pi-ai` 的关系是「设置入口由 pi-ai 侧提供，模型列表与推理由插件侧提供」的互补结构。插件的目录实现把 pi-ai 的内置表当作第一级回退（`src/catalog/index.ts:93-102`）并从中取 compat，所以静态快照提供的 29 个模型与对应 compat 在插件侧同样可用，不存在能力损失。

## 5. 建议

按优先级排列。第 1 条不依赖任何未决问题，可直接执行。

### 第 1 条：修正已失效的论断

改写 `README.md` 第 9–14 行与 `src/index.ts:1-13` 的模块说明，删去「generic pi-ai route 无法表达 per-conversation `x-opencode-session`」这一断言，改为陈述当前事实：会话头由 pi-ai 注入，本插件不再重复实现。

这不是文案调整。该断言一旦留在仓库里，后来维护者会据此重建 `src/session-header.ts`，并据同样的过期理由拒绝上游化。

**验证**：`tests/readme-consistency.spec.ts` 当前只守护 peer 数、测试文件数等字段，本次改写不触及这些字段，套件应保持全绿。

### 第 2 条：只收缩会话头这一项能力，保留路由注册

- 删除 `src/session-header.ts`，会话头交由 pi-ai 注入（依据见 §2.1）。
- **保留** `ctx.llm.registerAdapter([PROVIDER_ID], adapter)`（`src/index.ts:196`）。模型选择器的模型列表由适配器回答（`llm/src/index.ts:718-720`），live catalog 只有在插件持有路由时才会出现在选择器里；放弃路由注册会退回 pi-ai 的静态快照 29 个模型，插件最核心的能力随之消失。
- **保留**不注册目录条目的决定（`src/index.ts:98-115`）。设置页的 provider 配置入口由 `llm-pi-ai` 提供，重复声明会触发 `DUPLICATE_DIRECTORY` 并炸掉邻居（§4.2）。
- 保留 §4.1 的两处增量：stop 序列的协议路由、推理 token 的独立计量。

**收益**：去掉一处与上游重复的实现，减少一处维护面；插件的对外行为不变（会话头仍随每个请求发出）。

**风险与前置条件**：`src/session-header.ts` 导出 `providerHeaders`，被 `src/adapter.ts:50` 引用。删除后适配器不再自行设置该头，而依赖 pi-ai 的 `withOpenCodeSessionHeader` 生效——后者只在 `options.sessionId` 存在时注入（`opencode-headers.js:6-8`）。插件当前对无会话 id 的请求用一次性 UUID 兜底，删除后该路径会退化为无头请求，被网关以 `400 MissingSessionID` 拒绝。因此本条的实际执行形态是：**删除插件自带的实现，同时把 UUID 兜底提交给 pi-ai 上游**。在兜底进入上游之前，本条暂缓。

### 第 3 条：废弃 `src/update/`

DSH 插件管理器已有显式更新通道，provider 插件自带版本检查会与宿主机制形成两套更新来源。此项与前两条无耦合，可独立决定。

### 第 4 条：端点漂移说明（初稿的前提已消失）

初稿写的是「pi-ai 1.1.0 内置的 `opencode-go` 模型表指向旧端点 `https://opencode.ai/zen/go`，用户若按第 2 条卸载插件并改用 `llm-pi-ai`，必须在 provider profile 里显式填写新端点」。**按 1.3.0 实测，这条的前提已不成立**：内置模型表的 baseUrl 已经是 `https://opencode.ai/inference/go/v1`（与本插件的默认端点一致），不再指向 `zen/go`。因此**不需要**为「改用 `llm-pi-ai`」补这条警告。

不过 1.3.0 的表里仍有一处不统一，值得记一笔：部分条目的 baseUrl 是 `https://opencode.ai/inference/go`（无 `/v1`），另一些是 `https://opencode.ai/inference/go/v1`。本插件不受影响——`src/catalog/index.ts:104-107` 的 `modelBaseURLFor` 会把内置模型的 baseUrl **统一重定向**到配置端点。这构成插件目录实现的一项实际价值：它不只补齐模型，还统一了端点口径。

## 6. 未核实项

以下三项影响建议的边界，本文不作结论。

1. **网关侧官方文档的当前表述。** 「自 2026-09-05 起要求 `x-opencode-session`，缺失即 `400 MissingSessionID`」这一条目前的证据是本仓库 README 第 12 行、`CONTEXT.md` 第 40 行与上游 commit `561a2e06` 的间接印证，未直接读到 `opencode.ai` 官方文档页对当前规则的表述。若该规则已放宽，第 2 条中「删除 `src/session-header.ts`」的紧迫性下降，但结论方向不变。
2. **DSH 侧的实时目录承载能力——已核实，结论见 §4.2。** 目录条目与模型列表是两条独立通道：前者按 provider 键唯一，服务于设置页的 provider 配置入口；后者由适配器回答，服务于模型选择器。因此不存在「第三方目录覆盖静态目录」的需求，live catalog 经持有路由生效。`ctx.llm.registerModelDiscovery` 服务的是设置页的端点探测（`llm-pi-ai/src/index.ts:280`，客户端 `ui-settings-models/src/client/ModelListEditor.tsx:167`），与模型选择器无关。
3. **pi-ai 1.3.0 的 `opencode-go` 目录内容——已核实。** 初稿只核实了 1.1.0（31 个模型），并把 1.3.0 列为未核实项。第二次复核已按本机实装的 1.3.0 重算：29 个模型（`anthropic-messages` 5、`google-generative-ai` 1、`openai-completions` 18、`openai-responses` 5），比 1.1.0 **更少**，因此「实时目录仍是缺口」的结论**更强**（缺口由 6 个扩大为 8 个）。模型表的 baseUrl 也已从 `zen/go` 迁到 `inference/go/v1`（见 §5 第 4 条）。仍需留意的是：这些数字随 pi-ai 发版会变，本文的引用应随 `node_modules/@earendil-works/pi-ai/package.json` 的实装版本一起复核——`tests/upstream-facts.spec.ts` 已就「上游能力」这一类漂移设置了门禁。

另需注意：`scratch/` 已被 `.gitignore` 忽略、从未入库（见 [`README.md`](README.md) 第 48–54 行），第 2.2 节引用的抓包结论因此无法被克隆者复核；`adr/0006` 已将其摘要固化在受版本控制的文档中，本文沿用该摘要。

## 7. 范围外

- 本文不建议卸载插件。当前形态是可用且分工正确的，收缩是优化而非修复。
- 第 1 条与第 3 条互不依赖，可独立落地。
- 第 2 条依赖 pi-ai 上游接受 UUID 兜底（§2.1），在兜底进入上游之前暂缓。
- 若第 2 条被采纳，它构成一次架构决策，应另立 ADR（编号接续 `0007`），并按 `docs/README.md` 的约定更新索引与 `CONTEXT.md` 的相关词条。本文的结论速览（§1）与对照表（§3）可作为该 ADR 的依据。
