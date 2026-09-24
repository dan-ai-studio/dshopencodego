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

## 其他观察（未改代码）

- 页面初始化有一条 console error：`cannot get property "remote.session" without inject`（`Proxy.directoryFor`）。DSH 自己的 `ui-model-selection` 在相同位置做同样调用（`directoryFor(sessionId)`），故不是本插件的用法问题；未复现出功能影响。
- DSH 的 profile 模板在 `pnpm-workspace.yaml` 留下 `allowBuilds` 占位文本（`set this to true or false`），使首次 `dsh plugin add` 因 `ERR_PNPM_IGNORED_BUILDS` 退出 1，并**跳过 bundle 自动登记**（`reconcile` 只在成功运行的“新增依赖”上登记）。把 `@google/genai` / `protobufjs` 显式设为 `false` 后重跑即可；本次另按 runbook 的备选路径手工登记了 `dsh.profile.bundles`。这解释了 handoff 里“`dsh plugin add` 可能不登记 bundle”的一个成因。
- Release 资产名问题照旧：v0.1.3 的资产仍叫 `dan-ai-studio-dshopencodego-0.1.0.tgz`（`package.json` 未 bump）。

## 未覆盖

- `openai-responses` / `anthropic-messages` 的真实端到端（仍仅 mock）。
- 「保存 Key / 移除 Key」的实操（未触碰真实凭证；状态显示已由 `describe` 链验证）。
- 用量端点故障时的陈旧/重试语义（未在实机上模拟网络故障）。

## 证据文件（`scratch/`，不入库）

`m5web-dump-before.txt`、`m5web-dump-after.txt`、`m5web-proxy.jsonl`、`m5web-install{,2,3,4}.log`、`m5web-stdout{,2,3,4}.log`、`web-profile-*.bak`、`dshopencodego-m5fix{,2}.tgz`。
