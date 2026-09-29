# 验证记录（实机 / 真实网关）

按时间倒序。每节是一次真实环境验证的范围、方法、结论与未覆盖项；操作步骤见 `runbook-m5-live-verification.md`，版本对比见 `comparison-v0.1.13.md`。文中的模型数量是**当时快照**，目录随网关变化。

## 2026-09-29 · DSH 0.2.0-rc.2 适配（代码+单测，无网络）

范围：DSH `0.2.0-rc.2`（`D:\git\deepseek-harness` 现行检出）相对 `rc.1` 的破坏性核对与三项跟进。**不含**真机加载与网关调用，`package-lock` 的 `rc.2` tarball 重解析需联网另跑 `npm install`。

方法：

- 逐个核对插件消费面（`dsh-llm` 全导出、`credentials/launch-environment/timeout/brand/attachment`、`typert` 贡献形、`conversation.input.right/settings.section/configForms/modelDirectories`）在 `rc.2` 仍存在且签名未变；`LlmAdapter` 仍只有 `stream` 是抽象方法；
- `devDependencies` `0.2.0-rc.1` → `0.2.0-rc.2`（peer 范围已覆盖 `rc.2`，门禁无需改）；
- 新增 `OpencodeGoAdapter.prepareCall`：一次冻结 `config+catalog snapshot+model`，`stream` 与 `prepareCall` 共用 `streamWithSnapshot`（对齐 `llm-pi-ai` 的快照纪律），并加 `prepareCall generation` 回归单测；
- 新增 `scripts/patch-pi-ai.mjs`（`postinstall` 幂等执行）：移植 DSH `patches/@earendil-works__pi-ai@0.87.1.patch` 的 6 处逐 delta `parseStreamingJson` 删除，`0.87.1` 之外只告警跳过。

结果（2026-09-29 实跑，`node v24.20.0 / npm 11.19.0`）：

- 增量 `npm install` 在 `dsh-scope` 上 `ERESOLVE`（与 `rc.1` 同类），删 `node_modules` + 删 `package-lock` 重建后一次通过（`added 260 packages`，`postinstall` 补丁输出 `6 hunks applied across 6 files`，`prepare→build` 随安装通过）；
- `npm run typecheck`（host/client/tests 三工程）通过；
- `npm test`：27 个测试文件 / 172 个测试全绿（含新增 `prepareCall generation` 用例）；
- `npm run test:coverage` 覆盖率门禁通过；`npm pack --dry-run` 60 个文件；`npm ci --dry-run` exit 0；
- `peers` 不变即兼容 `rc.2`；`cordis 4.0.4` 在 `4.0.2 || 4.0.3 || 4.0.4` 内；`pi-ai` 与 Harness 同钉 `0.87.1`；
- 目录协议表仍是三协议（与 `pi-ai` 的 `opencodeGoProvider` 一致），`imageRequestPricing` 沿用基类缺省（用量以 provider 回传为准），无需改码。

未覆盖：`m5web` 隔离 profile 真机（设置页 + 用量按钮 + 图片，仍需人驾浏览器按 `runbook-m5-live-verification.md` 走）。

### Live 实测（同日稍后，构建产物 + 录制代理）

`npm run build` 后用 `tools/verify/recording-proxy.mjs`（本机沙箱拒绑 `8787`，改用 `18087`）+ `tools/verify/live-check.mjs session-rc2-0001 --allow-live` 跑两次同会话最小请求（`deepseek-v4-flash`，`Reply with the single word: pong`，`max_tokens=64`）：

```
GET  /zen/go/v1/models            STATUS=200 SESSION=(none) AUTH=none
POST /zen/go/v1/chat/completions  STATUS=200 SESSION=session-rc2-0001 AUTH=Bearer <set>
GET  /zen/go/v1/models            STATUS=200 SESSION=(none) AUTH=none
POST /zen/go/v1/chat/completions  STATUS=200 SESSION=session-rc2-0001 AUTH=Bearer <set>
```

- 两次推理 `200`，回 `pong`，`finish kind: pi-ai, version: 2`；用量 `91/15` 与 `91/28`；
- **同一会话两次 `x-opencode-session` 完全一致**，目录请求不带（符合设计）；
- 当场漂移两则：网关当时仅公布 **5 个模型**（此前 34–42，含 `deepseek-v4.1-flash` 仍在，`pi-ai` 内置目录不认识它，实时目录价值不变）；Go 文档两处源均无 allowance 表，`onFallback` 生效，会话头与推理不受影响。
- 花费：两次最小请求约 225 tokens；首行 `GET /v1/models 404` 是端口探针（缺 `/zen/go` 前缀），非适配器流量。

## 2026-09-29 · 测试零花费硬化（无网络单测 + live 价格锁）

动因：贵模型一次探测就能花不少钱；且此前适配器级单测仍在真实拉取 Go 文档（与"零网络"声明不符）。

改动：

- `OpencodeGoAdapter` 新增可选 `readDocument`（与 `OpencodeGoCatalog` 同形），生产缺省走真实拉取；6 处测试构造点全部注入 `offlineDocument()`。全套件耗时从 40s 降到 12s，佐证网络等待已消除；
- 新增 `tools/verify/cost-guard.mjs`：按内置目录价格估算最坏花费（含 8000 reasoning headroom），超 $0.01 或无报价直接拒绝，`--allow-expensive` 才能放行；已接入 `live-check.mjs`（钉死的 `deepseek-v4-flash` 照样过检，防未来涨价）与 `model-probe.mjs`（任意模型名，锁的重点）；
- 实测锁行为：`deepseek-v4-flash` 估算 ~$0.0049 放行；`kimi-k3` ~$0.1214 拦截；未知 id 拦截；`--allow-expensive` 放行并留日志。

结果：`typecheck` 通过；`npm test` 27 文件 / 172 用例全绿；`tools/verify/README.md` 与 `docs/plan.md` 同步立规矩。

## 2026-09-28 · DSH 0.2.0-rc.1 适配（本地门禁判定 + 单测，无网络）

范围：DSH 发布 `0.2.0-rc.1`（tag `dsh-v0.2.0-rc.1`，2026-09-28；npm `next` 已指向）后插件的加载兼容性。**不含**真机加载与网关调用。

背景：DSH 的插件门禁（`packages/boot/app-boot/src/plugin-compatibility.ts`）用运行时版本对插件每个 `@deepseek-ai/dsh-*` peer 做 `semver.satisfies(..., { includePrerelease: true })`；旧范围 `>=0.1.7-alpha.1 <0.1.8` 对 `0.2.0-rc.1` 全部不满足 → `dsh plugin add` 拒绝安装、已在盘上的插件启动时不被导入。

方法：

- 用 DSH 自身的门禁实现对插件 `package.json` 判定（运行时 `0.2.0-rc.1`）；
- semver 实测四种范围写法，选定 `>=0.1.7-alpha.1 <0.2.0 || >=0.2.0-rc.1 <0.3.0`（唯一同时通过 DSH 门禁与 npm/pnpm 默认 peer 规则的写法；`0.1.8`、`0.1.9` 从未发布，故写成两段）；
- devDependencies 升到 `0.2.0-rc.1`，并把 0.2.0 新增的传递 peer（`dsh-scope`、`dsh-invariants`、`dsh-sandbox`、`dsh-session`）显式加入；旧依赖树的增量解析在 `dsh-scope` 上冲突，最终删除 `node_modules` 并重建 lock（新 lock 通过 `npm ci --dry-run`）；
- `npm run typecheck`、`npm test`、`npm run test:coverage`、`npm pack --dry-run`。

结果：

- 门禁判定：改前不兼容 → 改后 `VERDICT: COMPATIBLE`（插件 `0.1.16`，运行时 `0.2.0-rc.1`）；
- typecheck 通过；27 个测试文件 / 171 个测试全绿；覆盖率门禁通过；打包 60 个文件（含 `lib` 与 `cordis.patch.yml`）；
- 源码零改动：0.2.0 对插件消费面（`dsh-llm`、`dsh-credentials`、`dsh-typert-*`、client 契约）只有增量变化，无破坏性变更；
- 改动面：`package.json`（17 个 `dsh-*` peer、`engines.dsh`、devDependencies）、`package-lock.json`、两份 README 的兼容性段落、`docs/plan.md` 的风险条目。

未覆盖：真机加载（隔离 profile 安装 → 启动 → 路由注册）、设置页与用量按钮、三种线协议的真实网关回归。跑法见 `runbook-m5-live-verification.md`。

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
