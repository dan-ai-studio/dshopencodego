# 验证：M5 实机（隔离 profile `m5web`）

日期：2026-09-25。目的：在**真实 Harness + 真实浏览器**里验证设置页与用量按钮（M5 的浏览器实测缺口）、图片输入，并补一次真实 Harness 进程内的会话头抓包。

## 方法

- 隔离 profile `m5web`：`pnpm dsh --profile m5web --from-default-profile web --dump-config` 初始化（shipped `web` 模板），随后装入本插件的 tarball。日常 `web` profile 全程未动。
- 操作界面：OpenCode 内置浏览器（Electron）驱动 `http://127.0.0.1:3080/`；页面内事件注入（Lexical `paste`、`document` `drop`）用于输入与附件。
- 抓包：`tools/verify/recording-proxy.mjs`（记录型反向代理），把 `m5web` 的插件 `baseURL` 临时指向 `http://127.0.0.1:8787/zen/go/v1`。
- 环境：`D:\git\deepseek-harness` @ `0.1.7-rc.2-477b4f4-dirty`；插件为本地构建（含下述两处修复）。

## 结果

### 1. 路由、目录与设置页

- 启动无路由冲突诊断；设置页出现「**OpenCode Go**」分区（修复后，见下）。
- 目录来自网关实时列表：**42 个模型 · 34 ✓ · 2 协议为推断**（`deepseek-flash`、`hy3-preview`）；8 个标「已弃用」。
- API Key 显示「**已配置**」（修复后）；「模型」区有「刷新」按钮；「目录刷新（分钟）」可改。
- 写入路径实测：改 `refreshMinutes` → 30、切换 `longcat-2.0` 开关 → 关，均落到
  `~/.dsh/profiles/m5web/cordis.patch.yml`：
  ```yaml
  - id: dshopencodego
    name: "@dan-ai-studio/dshopencodego"
    config:
      refreshMinutes: 30
      modelVisibility:
        longcat-2.0: false
  ```
  （同文件里的 `ui-settings-general.welcomeNoticeVersion` 是点「继续」时由 DSH 自己写入的，说明写入通道在实机上先于本项已工作。）

### 2. 用量按钮

会话输入框右侧的「OpenCode Go 用量」按钮渲染并可用，面板内容：
- 5 小时 6%（重置 2026/9/25 05:18:50）、本周 45%（重置 9/28 08:00）、本月 40%（重置 10/17 10:49）；
- 「自本次 Harness 启动以来」计数随对话增长；「更新于」时间戳；「重试」按钮；
- 文案与 `src/client/locales.ts` 逐字一致（这是确认 UI 连的是本插件的直接证据）。

### 3. 真实对话与图片输入

| 用例 | 结果 |
|---|---|
| `只回复：pong` | 回复 `pong`，用时 7 秒 |
| 只读工具调用（读 `README.md` 第一行） | 正确回复 `@dan-ai-studio/dshopencodego`，用时 10 秒 |
| 图片附件（红色方块 PNG，64×64） | 回复「红色」，用时 4 秒；附件缩略图在会话里正常渲染 |
| `只回复：ok` | 回复 `ok`，用时 4 秒 |

会话累计：5 轮 6 步、518K tok、缓存命中 67%。用户在自己浏览器中复核了同一会话（含两个图片附件与回复）。

### 4. 真实 Harness 内的会话头抓包

代理记录（`scratch/m5web-proxy.jsonl`）：

```
GET  /zen/go/v1/models            200  session=(none)  ua=deepseek-harness/0.1.7-rc.2
GET  /zen/go/v1/usage             200  session=(none)  auth=Bearer
POST /zen/go/v1/chat/completions  200  session=session-06f83ac8-c93b-4303-8fbb-b90de55e7eaa  auth=Bearer
POST /zen/go/v1/chat/completions  200  session=session-06f83ac8-c93b-4303-8fbb-b90de55e7eaa  auth=Bearer
```

- 推理请求 200，**携带 `x-opencode-session`，同一会话两次请求值完全一致**；
- 目录与用量请求不带会话头（符合设计：只有推理请求需要）；
- `user-agent` 为 Harness 归属头，凭证以 `Bearer` 发送。

## 实机发现并修复的两个缺陷

两个缺陷同源：**客户端 Remote 的真实运行时契约从未在真实页面里验证过**——单测的 mock 按当时（错误）的假设编写，因此没有拦住。

1. **设置分区永不注册**（`src/client/index.ts`）。客户端只 `$mount(usageRemote)`，catalog 的 descriptors 从未挂载，`remote.opencodeGoCatalog` 不存在，设置分区的 `inject` 永远不满足（静默不渲染）。Host 侧本来就按“一个 package 一个 contribution”把两类方法合并注册；客户端修复为同样合并再 `$mount`。
2. **API Key 误报「未配置」**（`src/client/Section.tsx`）。`remote.credentials.describe()` 返回的是 `RemoteResult` 信封（`{ok, value}`），页面按已解包的字典读取，`configured: true` 被读成 `false`。修复为按信封解包（与 DSH `ui-settings-models/src/client/operations.ts` 的用法一致）；`set` / `unset` 同样改为判 `.ok`；测试 mock 同步修正。

两处修复后重新构建、装回 `m5web`、重启复验：分区出现、Key 显示「已配置」、写入路径正常。`npm run typecheck` 与 58 个用例全绿。

## 追加验证：日常 `web` profile 上机（2026-09-25）

隔离 profile 验证通过后，日常 `web` profile 完成替换并补跑以下项。

### 5. 替换与上机

- 卸载 `@dan-ai-studio/dsh-opencode-go@0.1.15`，改装 v0.1.4（依赖记为 Release URL，不是本地路径）；`--dump-config` 确认新插件层在、旧插件无残留；`agent-default-model` 指向 `opencode-go/deepseek-v4.1-flash` 无需改动（路由 id 相同）。
- 替换前的现状快照存 `scratch/web-profile-*-20260925.*`。
- `web` profile 的 `pnpm-workspace.yaml` 早已有 `allowBuilds: {'@google/genai': true, protobufjs: true}`，因此没有遇到新 profile 上的 `ERR_PNPM_IGNORED_BUILDS` 问题。

### 6. 三种线协议的真实端到端

| 协议 | 模型 | 结果 |
|---|---|---|
| openai-completions | deepseek-v4.1-flash | 回复 `pong` / `ok`（7 秒 / 4 秒） |
| anthropic-messages | qwen3.8-flash | 回复 `ok`，10 秒 |
| openai-responses | grok-4.7 | 回复 `ok`，1 分 27 秒（思考型模型较慢） |

切换方式为 `--patch` 临时 overlay 覆盖 `agent-default-model`（不修改 profile 文件；验证后进程停掉即无痕）。**未用 UI 模型选择器切换**——新建会话时选择器的目录尚未就绪（只渲染当前项），实机操作放弃；overlay 方式不改变实际适配器路径，验证目标不受影响。

顺带发现（非缺陷）：`reasoningEffort: "max"` 对 `qwen3.8-flash`（无 thinkingLevelMap）与 `grok-4.7`（映射里 `max: null`）不被支持，插件/宿主明确报 `UNSUPPORTED_REASONING_EFFORT` 而**不是静默降级**（日常模型 `deepseek-v4.1-flash` 支持 `max`）；overlay 去掉档位后两者均正常。

### 7. 用量故障语义（陈旧保留）

方法：`scratch/usage-fail-proxy.mjs`（宽限窗口内放行 `/usage`，之后故意 503）+ 临时给插件配置加 `baseURL`。

- **同端点失败**：按钮显示 `Go · 5 小时 13% · 本周 47% · 陈旧`；面板保留三个窗口的数值与「更新于」时间戳，给出具体失败原因（`…answered HTTP 503`）与「重试」；**没有把不可用显示成 0**。
- **端点变化时**（刚切到代理）：显示「不可用」而非「陈旧」，符合"账号或端点变化时不保留"的设计。
- 失败期间客户端按间隔自动重试（代理日志可见多轮请求）。

验证后已移除临时配置、停掉代理，并用直连重启冒烟（按钮显示实时数值、无陈旧标记）。

### 8. Release 卫生

- v0.1.0 的 Release 已删除（tag 保留）。
- v0.1.4 是本项目第一个由 CI 产出的 Release（见下节）。

## 其他观察（未改代码）

- 页面初始化有一条 console error：`cannot get property "remote.session" without inject`（`Proxy.directoryFor`）。DSH 自己的 `ui-model-selection` 在相同位置做同样调用（`directoryFor(sessionId)`），故不是本插件的用法问题；未复现出功能影响。
- DSH 的 profile 模板在 `pnpm-workspace.yaml` 留下 `allowBuilds` 占位文本（`set this to true or false`），使首次 `dsh plugin add` 因 `ERR_PNPM_IGNORED_BUILDS` 退出 1，并**跳过 bundle 自动登记**（`reconcile` 只在成功运行的“新增依赖”上登记）。把 `@google/genai` / `protobufjs` 显式设为 `false` 后重跑即可；本次另按 runbook 的备选路径手工登记了 `dsh.profile.bundles`。这解释了 handoff 里“`dsh plugin add` 可能不登记 bundle”的一个成因。
- Release 资产名问题：v0.1.0–v0.1.3 的资产都叫 `dan-ai-studio-dshopencodego-0.1.0.tgz`（`package.json` 一直未 bump）；从 v0.1.4 起资产名与 tag 一致。
- **CI 此前从未跑通（本次修复）**：`ci` / `release` 的历史 run 全部失败，根因是 `package-lock.json` 与依赖树不同步——`vitest@4 → vite@8` 要求 `esbuild@^0.27 || ^0.28`，而 root 固定 `^0.25.0`，npm 的 dedupe 出无效树，`npm ci` 报 `Missing: esbuild@0.28.2 from lock file`。v0.1.0–v0.1.3 的 Release 资产因此实为手工上传（与 plan/handoff 中“CI 发 Release tarball”的说法不符）。修复：root 的 `esbuild` 升到 `^0.28.0` 并同步 lock（提交 `0b280c2`），本地复跑 `npm ci` + 测试通过后重发 v0.1.4；**v0.1.4 是本项目第一个由 CI 产出的 Release**。

## 未覆盖

- 设置页「保存 Key / 移除 Key」的实操：该写入作用于全局 `~/.dsh/.credentials.yaml`，无法隔离到临时 profile（插件的引用名固定为 `OPENCODE_GO_API_KEY`），为避免不可逆地改动真实凭证，**刻意不做**；只读的状态显示链（`credentials/describe`）已实机验证。

## 证据文件

验证期间的中间产物（profile 快照、dump、代理日志、安装日志、临时 overlay 与代理脚本）放在 `scratch/`（不入库）；验证结束后已按约定清理。
