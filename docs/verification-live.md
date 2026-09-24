# 验证：真实网关上的端到端证据

日期：2026-09-24。目的：证明两条核心声明在**真实网关**上成立，而不是只在本插件的自我视角里成立。

## 方法

1. `npm run build` → `npm pack` → `dsh plugin --profile dshsmoke add <tgz>` 装进隔离 profile `dshsmoke`（`dsh.profile.bundles` 含 `@deepseek-ai/dshopencodego`，`--dump-config` 可见该条目）。
2. 起一个**记录型反向代理** `tools/verify/recording-proxy.mjs`，把收到的请求原样转发到 `https://opencode.ai/zen/go`，并把收到的请求头写入 JSONL。
3. `tools/verify/live-check.mjs` 用**构建产物** `lib/index.js` 里的适配器，凭证取自 Harness 凭证库的 `OPENCODE_GO_API_KEY` 引用，baseURL 指向代理，发**一次最小请求**（`deepseek-v4-flash`，prompt 为 "Reply with the single word: pong"）。

代理只转发不篡改，因此抓到的就是真实 Harness 代码路径发出的字节。

## 结果

```
catalog: 34 models advertised by the gateway
has deepseek-v4-flash: true
has a model the installed pi-ai catalog does not know: true     # deepseek-v4.1-flash
reply: pong
chunks: 14
finish: {"type":"finish","reason":{"kind":"stop"},
         "replayState":{"response":{"kind":"pi-ai","version":2,"api":"openai-completions",
         "provider":"opencode-go","model":"deepseek-v4-flash",
         "responseId":"router-6d9badf90f174df899a214df02a22296","stopReason":"stop"},
         "blocks":[{"type":"reasoning","thinkingSignature":"reasoning_content"},{"type":"text"}]}}
usage: [{"model":"deepseek-v4-flash","usage":{"inputTokens":91,"outputTokens":19,"totalTokens":110}}]
```

代理记录（`proxy-log.jsonl`）：

```
PATH=/v1/models            STATUS=200 SESSION=(none) UA=deepseek-harness/0.1.7-rc.1 (+https://github.com/deepseek-ai/deepseek-harness) AUTH=none
PATH=/v1/chat/completions  STATUS=200 SESSION=session-livecheck-0001 UA=deepseek-harness/0.1.7-rc.1 (+https://github.com/deepseek-ai/deepseek-harness) AUTH=Bearer <set>
```

## 结论

- **实时目录成立**：目录来自网关 `/v1/models`（34 个模型），包含 `deepseek-v4.1-flash` 这个 pi-ai 0.87.1 内置目录里没有的模型，说明不再依赖构建期快照。
- **会话头成立**：推理请求携带 `x-opencode-session: session-livecheck-0001`，值与会话 id 完全一致；`user-agent` 为 Harness 归属头；凭证以 `Bearer` 发送。目录请求不带会话头（它不是推理请求），符合预期。
- **推理回放成立**：终态 `finish` 带 `kind: pi-ai, version: 2` 的 replay 信封，逐块签名（reasoning 的 `reasoning_content` 与 text）被保留。
- **用量成立**：该次调用回传 91 输入 / 19 输出 token，被计量器记录。

## 真实 Harness 进程内的激活验证（2026-09-24，第二轮）

之前 headless 无输出的原因查清了：`dsh plugin add` 给新 profile 建的是**裸 profile**，`dsh.profile.bundles` 里只有 `@deepseek-ai/dsh-base`（库包），没有 app 包，因此 `dsh --profile <裸profile> "hi"` 既无输出也不发请求。

改用官方模板重建后验证通过：

```sh
dsh --profile dshheadless --from-default-profile headless --dump-config   # bundles: dsh-base + dsh-headless
dsh plugin --profile dshheadless add <本地 tarball>                        # 远程 URL 会命中 ERR_PNPM_MISSING_TARBALL_INTEGRITY，见下
dsh --profile dshheadless --dump-config | grep dshopencodego              # 组合里出现该条目
dsh --profile dshheadless --patch <不存在的模型> "hi"
```

输出：

```
dsh: UNKNOWN_MODEL: opencode-go has no model "definitely-not-a-real-model"
```

这条错误由**本插件的适配器**抛出（`adapter.ts` 的 `UNKNOWN_MODEL`），因此它证明：插件已加载、`apply()` 已执行、`opencode-go` 路由已注册（凭证解析成功）、目录已从真实网关取回，且 Harness 的 agent 循环确实调到了本适配器。故意用一个不存在的模型，使激活验证**零额度消耗**。

已知安装怪癖：把 Release 的 **远程 tarball URL** 装进一个**已有缓存的 profile** 会报 `ERR_PNPM_MISSING_TARBALL_INTEGRITY`（pnpm 要求 lockfile 有 integrity，而本机缓存命中时不会补写）。解法：下载到本地后按路径安装（`dsh plugin add <绝对路径>`），或在全新 profile 中首次安装。

## 未覆盖

- **发布产物的独立导入失败（发布级风险，未解决）**：把 Release tarball 装进隔离 profile 后，用独立 `node` 直接导入 `@dan-ai-studio/dshopencodego` 会抛
  `SyntaxError: The requested module '@deepseek-ai/dsh-llm' does not provide an export named 'IMAGE_OFFLOAD_REQUIRED_CODE'`。
  原因是 profile 的 `node_modules` 里 hoist 了一份更旧的已发布 `dsh-llm`（npm 上该包的 `latest` 标签是 `0.0.1-rc.1`），而 `src/conversion/context.ts` 对 0.1.6+ 才有的导出用了**具名导入**。真实 Harness 由自己的 loader 提供 `dsh-llm`，因此运行时预期不受影响，但这一点**尚未在真实 Harness 进程里验证过**（本轮只验证了 `--dump-config` 的组合结果，它不激活插件代码）。
  修法（下一轮做）：对版本敏感的导出改用命名空间访问（`import * as llm from '@deepseek-ai/dsh-llm'` 后读 `llm.IMAGE_OFFLOAD_REQUIRED_CODE`），参考实现正是为此采用该写法；随后在真实 Harness 进程内验证插件激活。
- 全流程 `dsh` 交互式运行：headless 调用在本机挂起（无输出、无请求到达代理），原因未查清；本次用构建产物直接驱动适配器，绕过了 DSH 的 agent 循环与交互层。
- `openai-responses` 协议的端到端（mock 与真实均未跑）。
- 图片输入（需要带附件的真实会话）。
- 完整设置页 UI（本轮只交付了会话内用量按钮；设置页尚未实现）。
