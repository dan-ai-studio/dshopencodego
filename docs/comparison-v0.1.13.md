# 对比：v0.1.13 是怎么实现的，我们哪里不同

对象：`D:\git\dsh-opencode-go`（`@dan-ai-studio/dsh-opencode-go@0.1.13`，src 约 200KB + tests 约 200KB）。本文按机制拆解它的实现，并标注新项目采用/修改/放弃的部分。

## 1. 形态与构建

| 机制 | v0.1.13 | 新项目 |
|---|---|---|
| Host 产物 | `src/index.ts` → esbuild 打包 `lib/index.js`（ESM，`packages: 'external'`），类型由 `tsc -p tsconfig.host.json` 出 `.d.ts` | 相同栈 |
| Client 产物 | `src/client/index.ts` → esbuild CJS + `banner/footer` 包成 `window.__ModuleLoader__.load({id, factory})`；CSS Modules 由 lightningcss 编译并注入 `<style data-plugin-css>`；外部化 react / cordis / client-store / ui-slots / ui-primitives，并在构建后校验 metafile 里的 external 清单 | 相同栈（这套已验证可被 DSH Web 加载） |
| 测试宿主 | `tests/hosts/{v015-rc1,v016-alpha2,v017-rc1}` 各 vendored 一份 DSH 包 | 只保留 0.1.7 一份 |
| 兼容垫片 | settings 两代 API、image offload 两代 API、Typert codec 双形态（`schema` / `create()`） | 全部删除（只支持 0.1.7 系列） |

## 2. 路由生命周期（`index.ts`）

- `apply()` 解析配置后：注册 Typert remotes → `ctx.plugin(GoUsageService)` → 构造 adapter → `ctx.plugin(GoModelsService)` → 注册模型发现 → **凭据门控地注册路由**。
- `applyRoute(configured)`：只有 `enabled === true` **且** 凭据引用已配置时才 `ctx.llm.registerAdapter([PROVIDER_ID], adapter)`；否则注销。触发点有四个：启动、`credentials/reference-updated`、`loader/volatile-update`、settings `onChange`。
  - 目的：没配 key 的 provider 不应出现在每个模型选择器里（与 `llm-pi-ai` 的"零路由即休眠"一致）。
- 可见性变化时 `registration.replace([PROVIDER_ID])`：借注册表的原子替换通知所有已打开的 picker，无需重启。
- `DUPLICATE_ADAPTER`（例如 profile 里 `llm-pi-ai` 也声明了 `opencode-go`）→ **只记 error，其余功能照常**（发现、设置页、凭据监听都还在）。
- 模型发现注册在整个命名空间上（`registerModelDiscovery(name, …)`），并拒绝非 `opencode.ai` 的 baseURL。

**新项目沿用**：门控注册、原子 replace、冲突只降级不崩。**修改**：把"路由被占用"从一行 error 升级为一等诊断（含占用者提示与处置建议），因为新插件与旧插件互斥是已知状态。

## 3. 目录：三层，不是四级

1. **网关成员**：`GET {base}/models`（`cache: 'no-cache'`、10s 超时、1MB 上限），读 `data[].id`，去重。
2. **在线元数据**：`GET https://models.dev/api.json`（ETag/If-None-Match 条件请求、16MB 上限），只读 `opencode-go` 记录。
3. **内置兜底/兼容源**：pi-ai 的 `getBuiltinModels('opencode-go')`，把 `provider` 改成 `opencode-go`、`baseUrl` 按协议重写。

缓存与失败语义（`OpencodeGoCatalog`）：

- `snapshot(force)`：TTL = `refreshMinutes`；并发读合并（`pending` 复用）。
- `forModel(id)`：**未知 id 且当前快照来自缓存时会强制刷新一次**（新模型即时发现的关键）。
- 列表失败 → 保留上次模型（首次失败则为空），`live: false`，`listingFailure` 保留给显式发现报错；元数据失败 → 保留上次元数据并 `onFallback` 告警。
- 成员资格由网关决定；**每模型**元数据失败进入 `unavailable`（设置页显示为 `configurationMissing` 并禁用，picker 不显示），而不是整体失败。

**新项目沿用**：ETag、`forModel` 强制刷新、逐模型失败隔离、陈旧标记。**修改**：`unavailable` 只保留给"四级阶梯全都判不出协议"的模型（当前实测只剩 `deepseek-flash`、`hy3-preview` 两个候选，且都能被家族规则兜住）。

## 4. 协议判定：只认 models.dev 的 `provider.npm`

`readModelMetadata` 的判定是三级映射，**没有家族启发式**：

```
per-model provider.npm ?? provider-level npm
  @ai-sdk/anthropic        → anthropic-messages
  @ai-sdk/openai           → openai-responses
  @ai-sdk/openai-compatible→ openai-completions
  其它/缺失                 → 抛错 → 该模型 configurationMissing
```

其余字段：`limit.context/output` → 容量；`modalities.input` 含 image → `['text','image']`；`reasoning` + `reasoning_options`（toggle/budget_tokens → off+high；effort.values → 逐级）→ `thinkingLevelMap`；`cost`（含 context 分层 tiers）→ 单价；`interleaved.field === 'reasoning_content'` → `requiresReasoningContentOnAssistantMessages`。

两个精巧处：

- **同族兼容继承**：若该 id 在 pi-ai 内置目录里且协议一致，用它的 `compat`；否则找 `family` 相同、且内置目录认识、协议一致的另一个模型，继承其 `compat`（新模型自动拿到同族线怪癖）。
- **baseUrl 按协议重写**：`anthropic-messages` 去掉结尾 `/v1`（Anthropic SDK 自己拼 `/v1/messages`），其余保留。

**新项目修改**：把这一层降为阶梯的第二级。第一级是 pi-ai 0.87.1 的精确条目（协议 + compat 全给），第三级是家族启发式，第四级是配置覆盖。

实测数据（2026-09-24，网关 42 个模型 vs pi-ai 0.87.1 认识的 30 个 vs models.dev 41 个）修正了一个想当然的判断：**12 个 pi-ai 不认识的网关模型里，10 个仅凭 models.dev 就已完全可配置**（协议、`reasoning`、`limit.context/output`、文本模态齐全），真正缺配置的只有 `deepseek-flash` 与 `hy3-preview`（models.dev 里根本没有这两条）。因此阶梯的价值不是"救回 12 个模型"，而是三件更小的事：

1. **消除来源冲突**：`minimax-m2.7` 在 models.dev 标 `@ai-sdk/anthropic`，pi-ai 目录却归 `openai-completions`。v0.1.13 只信 models.dev，会把它送上 messages 路径。
2. **补齐 compat**：0.87.1 的精确条目自带 `thinkingFormat: deepseek`、`requiresReasoningContentOnAssistantMessages` 等线怪癖，models.dev 只能通过 `interleaved.field` 间接推断。
3. **兜住缺口**：`deepseek-flash`（deepseek 族）与 `hy3-preview`（hy3 族）由家族规则判为 `openai-completions`，与同族已知模型一致；判错时 UI 标注"推断"且配置可覆盖。

家族启发式因此必须收窄，不能用"`qwen*` → messages"这类粗暴规则：pi-ai 目录里 `qwen3.8-flash` 是 messages，而 `qwen3.6-plus`/`qwen3.7-*`/`qwen3.8-max` 都是 completions；`minimax-m3` 是 messages 而 `minimax-m2.7` 是 completions。可用的规则只有两组：`grok*`/`gpt*`/`muse-*` → `openai-responses`（与目录完全一致），其余 → `openai-completions`。

## 5. 适配器（`adapter.ts`）

一次 `stream()` 的顺序：配置 → `catalogOf(config).forModel(model)`（按 `baseURL|refreshMinutes` 缓存 catalog 实例）→ 套用逐模型容量覆盖 → `maxTokens` 取配置上限的 min → 解析凭据（空则 `MISSING_CREDENTIAL`）→ 校验推理档位（不钳制，不合法即 `UNSUPPORTED_REASONING_EFFORT`）→ `idleWatchdog` → 图片门（模型必须声明 image 且附件服务在位）→ `toPiContext` → `provider.streamSimple(...)` → `toStreamChunks` → 在 watchdog 下迭代。

请求头（本插件的存在理由）：

```ts
headers: {
  'x-opencode-session': opencodeSessionValue(options.sessionId),  // 无 sessionId → randomUUID()
  ...attributionHeaders(),                                        // user-agent 由 Harness 拥有
},
maxRetries: 0,   // 重试归 agent 恢复层
```

`listModels` 按可见性过滤：`configurationMissing` 永远不可见；`modelVisibility[id]` 显式优先；否则"弃用默认关"。

推理档位默认值只在"未设置档位就会显式关闭思考"的格式上给（`deepseek`/`zai`/`qwen`/`qwen-chat-template` → `high` 或最高非 off），其余交给 provider 默认。

**新项目沿用**：整个顺序、头注入、`maxRetries: 0`、watchdog、图片门、档位默认值策略。**修改**：`x-opencode-session` 的取值与兜底写成不变量测试（含标题/压缩/子代理路径）。

## 6. 转换层（`conversion/`）

- **context.ts**：DSH 消息 → pi-ai `Context`。系统提示拆分（`options.system` 优先；否则取首条 system 消息，空文本则不发）；tool 结果重建为 `toolResult` 消息，**工具名从前面 assistant 的 toolCall 反查**；图片走附件服务的 `readImageRequest`（像素/字节预算），并用 `requiredImageOffload`/`projectOffloadedImages` 遵守宿主的持久化卸载协议（超限抛 `IMAGE_OFFLOAD_REQUIRED` 并告知还需卸载几张）。
- **stream.ts**：pi-ai 事件 → DSH `StreamChunk`。usage 映射（缓存字段仅在非 0 时出现）；停止原因映射含上下文溢出（`isContextOverflow` + 文本判定）、空响应 → error、`pending`/`deferred` → 不可重试错误；**错误文本分类**（401/403→AUTH、配额、429、413/400→INVALID_REQUEST、5xx、超时、`stream ended before/without`/`terminated`/`premature close`→TRANSPORT）。
- **replay.ts**：版本化信封 `{kind:'pi-ai', version:2}` 存 response 级（api/provider/model/responseModel/responseId/providerThinkingLevel/stopReason）+ 逐块签名（textSignature/thinkingSignature/thoughtSignature/redacted）；读回时严格校验，任何不匹配**降级为 provider-neutral 历史**而不是让请求失败。
- **image-offload.ts**：跨 DSH 两代图片卸载 API 的桥（命名空间访问，避免在旧宿主上因命名导入而加载失败）。

**新项目沿用**：全部四块（这是最难、最容易写错的部分）。**修改**：删除两代桥，直接调用 0.1.7 的 `requiredImageOffload`/`projectOffloadedImages`。

## 7. 用量与 Remote

- `GoUsageService extends TypertRemoteService('opencodeGoUsage')`：`GET {base}/usage` + `Bearer`，10s 超时、1MB 上限；解析 `{rolling, weekly, monthly}` 三窗口（`status`、`percent`、`resetsAt`）。
- 失败语义细致：凭据缺失 → 不可重试且不保留旧值；传输/JSON 失败 → 可重试、保留旧值并带 `source` 身份（账号或端点变了就不保留）；429/5xx → 可重试且保留。
- `GoModelsService` + `modelsRemote`：设置页读完整目录（含 `deprecated`、`releaseDate`、`configurationMissing`、`stale`、`error`）。
- 契约用模块增强声明 `TypertRemoteNamespaceMap`，codec 同时支持已发布 DSH 的 `schema` 形态与源码构建的 `create()` 形态。

**新项目修改**：端点三窗口之外，增加**会话级真实统计**（折叠会话内 assistant 消息的 usage：输入/输出/缓存读/写/成本）与**自本次启动以来**的内存累计，并如实标注口径；codec 只做 0.1.7 形态。

## 8. 客户端

`src/client/` 约 70KB：`section-controller.ts`（表单状态机）+ `staged-form.ts`（暂存/提交/校验）+ `Section.tsx`（设置页：API Key、目录、逐模型开关、容量覆盖）+ `ModelEditor.tsx` + `UsagePill.tsx`（会话内用量按钮，仅当前 provider 是 `opencode-go` 时挂载轮询，60s + 可见性触发 + 手动重试）+ `locales.ts`（中英）+ CSS Modules。

**新项目沿用**：同样的界面面与交互语义（用户已确认"完整对齐"），实现上收敛为更少的文件与更少的状态机分支。

## 9. 测试与验证

- 单测/契约测试约 200KB：mock 网关（`tests/mock-gateway.ts`）、目录（含动态目录）、适配器、上下文转换、动态配置、loader 组合、模型限制/可见性、用量、host 兼容性、包兼容性。
- 客户端组件测试：设置区、stores、用量按钮、本地化、模型选择、构建产物、客户端入口。
- `docs/verification.md`（44KB）是逐条证据日志，含对真实 `/usage` 端点的一次只读检查。

**新项目沿用**：mock 网关 + 契约测试 + 组件测试 + 安装冒烟；**新增**：三层验证的第三层（一次真实最小请求 + 抓包确认会话头）。

## 10. 一句话结论

v0.1.13 的骨架是对的（自有路由 + 实时目录 + 自注入头 + 完整 UI），它的短板集中在四处：**协议判定只信 models.dev**（会把 `minimax-m2.7` 判到 messages，也拿不到 0.87.1 才有的 compat）、**pi-ai 0.85.1 缺新模型的 compat**、**用量只有账号三窗口**、**三代兼容垫片带来的维护面**。这四处都不是"它跑不起来"，而是"它在边界上不够准、在维护上不够轻"——重写的收益要按这个尺度衡量。新项目保留其骨架与转换层智慧，在这四处换实现，并把自己的两份依赖（pi-ai 0.87.1、DSH 0.1.7）钉死。
