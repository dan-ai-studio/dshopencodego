# 验证记录（实机 / 真实网关）

按时间倒序。每节是一次真实环境验证的范围、方法、结论与未覆盖项；操作步骤见 `runbook-m5-live-verification.md`，版本对比见 `comparison-v0.1.13.md`。文中的模型数量是**当时快照**，目录随网关变化。

## 2026-09-25 · M5 实机（隔离 `m5web` + 日常 `web` 上机）

范围：真实 Harness + 真实浏览器里的设置页与用量按钮、图片输入、真实进程内的会话头抓包。

方法：`pnpm dsh --profile m5web --from-default-profile web` 初始化隔离 profile 后装本地 tarball（日常 `web` 全程未动）；Electron 内置浏览器驱动 `http://127.0.0.1:3080/`，页面内事件注入（Lexical `paste`、`document` `drop`）用于附件；`tools/verify/recording-proxy.mjs` 记录型反向代理；环境 `0.1.7-rc.2-477b4f4-dirty`。

结果（隔离 profile）：

- 设置页出现「OpenCode Go」分区；目录 = **42 个模型 · 34 启用 · 2 协议为推断**（`deepseek-flash`、`hy3-preview`）· 8 个已弃用。
- API Key 显示「已配置」；`refreshMinutes` 与逐模型开关的写入落到 `~/.dsh/profiles/m5web/cordis.patch.yml`。
- 用量按钮：5 小时 6% / 本周 45% / 本月 40%，含重置时间与「更新于」；文案与 `src/client/locales.ts` 逐字一致。
- 真实对话：`pong`（7s）、只读工具调用读 `README.md`（10s）、红色方块 PNG 附件回复「红色」（4s）、`ok`（4s）；5 轮 6 步、518K tok、缓存命中 67%。
- 代理记录：推理请求 `POST /zen/go/v1/chat/completions` 200 且**同一会话两次的 `x-opencode-session` 完全一致**；目录与用量请求不带会话头（符合设计）。

实机发现并修复的两个缺陷（同源：客户端 Remote 的真实运行时契约从未在真实页面里验证过，单测 mock 按错误假设编写）：

1. **设置分区永不注册**（`src/client/index.ts`）：客户端只 `$mount(usageRemote)`，catalog 的 descriptors 从未挂载，`remote.opencodeGoCatalog` 不存在，分区的 `inject` 永远不满足。修复为一个 contribution 合并两类方法后挂载（与 Host 侧“一个 package 一个 contribution”一致）。
2. **API Key 误报「未配置」**（`src/client/Section.tsx`）：`credentials.describe()` 返回 `RemoteResult` 信封（`{ok, value}`），页面按已解包字典读取，`configured: true` 被读成 `false`。修复为按信封解包，`set` / `unset` 同步改判 `.ok`。

日常 `web` profile 上机（同日）：

- 替换：卸载 `@dan-ai-studio/dsh-opencode-go`，依赖记为 Release URL 装入 v0.1.4；`--dump-config` 确认新层在、旧插件无残留；`agent-default-model` 指向 `opencode-go/deepseek-v4.1-flash` 无需改动（路由 id 相同）。
- 三种线协议端到端（用 `--patch` overlay 切换，不改 profile 文件）：`openai-completions` / `deepseek-v4.1-flash` → `pong`；`anthropic-messages` / `qwen3.8-flash` → `ok`（10s）；`openai-responses` / `grok-4.7` → `ok`（1m27s）。
- 顺带（非缺陷）：`reasoningEffort: max` 对无 `thinkingLevelMap` 的 `qwen3.8-flash` 与映射 `max: null` 的 `grok-4.7` 报 `UNSUPPORTED_REASONING_EFFORT`，**不是静默降级**；去掉档位后正常。
- 用量故障语义：同端点 503 → 按钮显示「陈旧」并保留三窗口数值与「更新于」，**不把不可用显示成 0**；端点变化 → 显示「不可用」（不保留旧读数的设计生效）；失败期间按间隔自动重试。
- 其他观察：页面初始化有一条 console error `cannot get property "remote.session" without inject`（`Proxy.directoryFor`），DSH 自己的 `ui-model-selection` 同样调用，非本插件用法问题；模板 `pnpm-workspace.yaml` 的 `allowBuilds` 占位文本会让首次 `dsh plugin add` 因 `ERR_PNPM_IGNORED_BUILDS` 退出且跳过 bundle 登记；v0.1.0–v0.1.3 的 Release 资产名与 tag 不一致（从 v0.1.4 起一致）；CI 历史上从未跑通，根因是 `package-lock.json` 与依赖树不同步（`vitest@4 → vite@8` 要求 `esbuild@^0.27 || ^0.28`，root 钉了 `^0.25.0`），已修复（提交 `0b280c2`），**v0.1.4 是第一个由 CI 产出的 Release**。

未覆盖：设置页「保存 Key / 移除 Key」的实操（写入全局 `~/.dsh/.credentials.yaml`，引用名固定，无法隔离到临时 profile，为避免不可逆改动刻意不做；只读状态链已实机验证）。

## 2026-09-24 · 真实网关端到端 + Harness 进程内激活

范围：证明"实时目录"与"会话头"在**真实网关**上成立，并在真实 Harness 进程内确认插件被激活。

方法：`npm pack` → 装入隔离 profile `dshsmoke`；`tools/verify/recording-proxy.mjs` 把请求原样转发到 `https://opencode.ai/zen/go` 并记录请求头；`tools/verify/live-check.mjs` 用**构建产物** `lib/index.js` 的适配器发一次最小请求（`deepseek-v4-flash`，prompt `Reply with the single word: pong`）。代理只转发不篡改，抓到的就是真实代码路径发出的字节。

结果：

```
catalog: 34 models advertised by the gateway
has a model the installed pi-ai catalog does not know: true     # deepseek-v4.1-flash
reply: pong, chunks: 14, finish: stop
usage: input 91 / output 19 / total 110
PATH=/v1/models            STATUS=200 SESSION=(none) AUTH=none
PATH=/v1/chat/completions  STATUS=200 SESSION=session-livecheck-0001 AUTH=Bearer <set>
```

- **实时目录成立**：目录来自网关 `/v1/models`，含 pi-ai 0.87.1 内置目录没有的 `deepseek-v4.1-flash`，不再依赖构建期快照。
- **会话头成立**：推理请求携带 `x-opencode-session`，值与会话 id 一致；目录请求不带（它不是推理请求）。
- **推理回放成立**：终态 `finish` 带 `kind: pi-ai, version: 2` 信封，`reasoning_content` 与 text 的逐块签名保留。

真实进程内激活（同日第二轮）：`dsh plugin add` 给新 profile 建的是**裸 profile**（`dsh.profile.bundles` 只有库包、没有 app 包），因此 `dsh --profile <裸profile> "hi"` 无输出也不发请求；换成官方模板后，故意用不存在的模型得到

```
dsh: UNKNOWN_MODEL: opencode-go has no model "definitely-not-a-real-model"
```

该错误由本插件的适配器抛出，证明插件已加载、`apply()` 已执行、路由已注册、目录已从真实网关取回，且**零额度消耗**。

已知安装怪癖：把 Release 的**远程 tarball URL** 装进**已有缓存的 profile** 会报 `ERR_PNPM_MISSING_TARBALL_INTEGRITY`（pnpm 要求 lockfile 有 integrity，缓存命中时不补写）；下载到本地按路径安装即可。

未覆盖：`openai-responses` 的端到端（当时）、图片输入、完整设置页（当时只交付了用量按钮）；测试套件的偶发失败有一次未能复现（此前已定位并修复首个原因：用"关掉 mock 服务器"模拟故障会与 keep-alive 连接池竞态，改为按需返回 500 后 18 轮 × 936 用例零失败）。

## 2026-09-24 · pi-ai 0.87.1 升级调研

范围：pi-ai 最新版是否内置会话头、能否升级。方法：npm registry 元数据 + unpkg 已发布产物原始片段 + 本机 DSH 检出（`0.1.7-rc.1`）交叉核对。

- `@earendil-works/pi-ai` `latest` = **0.87.1**；`dist/providers/opencode-headers.js` 导出 `withOpenCodeSessionHeader`，但只包装**由 `opencodeGoProvider()` 构造的 provider**；本插件与 DSH 都用裸工厂（`openAICompletionsApi()` 等）自建 provider，因此不自动生效，且它只在 `sessionId` 存在时注入、无兜底值。
- 可导入性：`exports` 含 `"./providers/*"`，`@earendil-works/pi-ai/providers/opencode-headers` 可用（子路径属公开面）。
- 目录：0.85.1 的 `opencode-go` 27 个模型；0.87.1 为 30 个（新增 `deepseek-v4.1-flash`、`mimo-v2.6-flash`、`mimo-v2.6-pro`、`grok-4.7`）；网关当时公布 42 个 ID，仍有多达 12 个模型没有任何协议元数据。
- 我们使用的 pi-ai 符号在 0.85.1 与 0.87.1 均存在且签名未变；`providers/all` 导出逐行一致。
- 代价：DSH 对 0.85.1 打了私有补丁（删除 delta 路径上的增量 JSON 解析）；升到 0.87.1 而不移植，等于恢复"流式工具调用时反复全量解析"的开销，正确性不受影响。
- 结论：**可以升且 API 面无破坏**；会话头仍应由插件自己注入（我们才有"无会话 ID 时兜底"与"同会话值稳定"的可断言语义），pi-ai 的包装器只作可选加固。DSH 核心的 pin、补丁与 compat 门禁不在交付路径上。
