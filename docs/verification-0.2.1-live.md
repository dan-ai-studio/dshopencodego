# Runbook：0.2.1 适配实机验证（隔离 profile）

日期：2026-10-10。写给执行者（人 + agent 均可）。
目的：在真实 DeepSeek Harness **0.2.1-alpha.2** 上验证 `dshopencodego` 适配后的行为，
重点是第二批改动（依赖对齐、cordis 4.0.5、pi-ai 1.0.x）没有改变任何对外契约，
并把测试套件覆盖不到的两处语义变化（`dsh-timeout` 空闲 demand、cordis effect disposer）
在真实进程里确认一次。

**方案**：新建隔离 profile `v021`（从 shipped `web` 模板初始化），用**本地打包**的当前分支
tarball 安装。全程不动日常 `web` profile，删掉 `v021` 即完全回滚。

## 0. 前置事实

| 事实 | 值 | 影响 |
|---|---|---|
| 待验证插件 | 分支 `chore/upgrade-dsh-0.2.1-alpha.2`，两个提交（`d881813` 依赖对齐、`8fc0e3c` 时钟注入），`package.json` 仍是 `0.1.20` | `npm pack` 产物名为 `dan-ai-studio-dshopencodego-0.1.20.tgz`；**不要**依赖旧文档里写死的资产名 |
| 目标 DSH | tag `dsh-v0.2.1-alpha.2` | 见 S1；若用本地 `master` 需记录领先 tag 多少个提交 |
| 运行入口 | 在 DSH 检出下 `pnpm dsh ...`（`dsh` 不在 PATH） | 所有命令按此形式 |
| peer 目标代 | cordis `4.0.5-alpha.1` + cordis-plugin-loader `1.0.6-alpha.1` / group `1.0.5-alpha.1` / include `1.0.10-alpha.1` / schemastery `3.18.5-alpha.1` | profile 安装时若出现 ERESOLVE 或 peer 警告，**先停下排查**，这是本 runbook 的核心判据之一 |
| 会话/日志 | 运行会新写 `~/.dsh/{sessions,logs,attachments}` | 属目录外写入，见 §4 |
| 抓包工具 | 仓库内 `tools/verify/recording-proxy.mjs` | S8 复用 |

## 1. 完成判据（全过才算过）

1. **安装**：隔离 profile 装上插件，无 ERESOLVE、无 `dsh-invariants` 残留解析失败、无无法满足的 peer 警告。
2. **注册**：启动日志出现 `dshopencodego: route "opencode-go" registered as OpenCode Go`，**不出现** `not registering ... another adapter already owns it`。
3. **基础对话**：一条普通回复 + 一次只读工具调用，均正常，用量计数增加。
4. **图片输入**：一次带图对话得到合理回复。
5. **会话头**：同一会话内 `x-opencode-session` 存在且值稳定，跨轮次不变。
6. **流式终止语义**：连接被 kill / 上游黑洞两种情况下，请求都在 `streamIdleTimeoutMs` 量级内以错误结束，**不永久挂起**。
7. **目录降级**：网关 listing 指向黑洞时，设置页标记 stale 但仍列出模型，插件只 warn 不崩。
8. **route 生命周期**：配置里停用/启用插件，route 干净撤除与恢复，无重复注册日志。

## 2. 动线

### S0 仓库内准备（无授权要求）

```powershell
cd D:\prj\dshopencodego
New-Item -ItemType Directory -Force scratch | Out-Null
Copy-Item "$env:USERPROFILE\.dsh\profiles\web\package.json" scratch\web-profile-package.json.bak
Copy-Item "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml" scratch\web-profile-cordis.patch.yml.bak
git status --short        # 必须只有干净工作区；当前分支应为 chore/upgrade-dsh-0.2.1-alpha.2
```

### S1 切 DSH 检出到目标 tag

```powershell
cd D:\git\deepseek-harness
git branch --show-current | Tee-Object -FilePath D:\prj\dshopencodego\scratch\dsh-original-branch.txt
git rev-parse HEAD | Tee-Object -FilePath D:\prj\dshopencodego\scratch\dsh-original-head.txt
git status --short         # 必须干净，否则先处理
git checkout dsh-v0.2.1-alpha.2
git describe --tags        # 期望 dsh-v0.2.1-alpha.2
```

- 若不想动这个检出：改用 `git worktree add D:\git\dsh-021 dsh-v0.2.1-alpha.2` 并在新检出里
  `pnpm install`（monorepo 首次安装较久，含 node-pty 等原生构建）。
- **注意**：只 `git checkout` 不重装时，`node_modules` 可能还是原分支的代。若启动后出现
  "找不到模块/版本不符"，在该检出里跑一次 `pnpm install` 再继续。

### S2 打包插件（本地路径，勿用远程 URL）

```powershell
cd D:\prj\dshopencodego
npm pack 2>&1 | Select-Object -Last 3
Get-ChildItem dan-ai-studio-dshopencodego-*.tgz | Select-Object Name, Length
```

- `prepack` 会自动 build；若 build 失败先修，不要带着脏包验证。
- 记下**实际**文件名（预期 `dan-ai-studio-dshopencodego-0.1.20.tgz`）。

### S3 创建隔离 profile 并安装

```powershell
cd D:\git\deepseek-harness
pnpm dsh --profile v021 --from-default-profile web --dump-config > D:\prj\dshopencodego\scratch\v021-dump-before.txt
pnpm dsh plugin --profile v021 add D:\prj\dshopencodego\dan-ai-studio-dshopencodego-0.1.20.tgz
```

- 预期：pnpm 安装退出码 0，**没有** ERESOLVE、**没有** peer 警告、**没有** `declares no dsh.bundle` 警告。
- 若 pnpm 把 `--profile` 当自身参数：写成 `pnpm dsh -- --profile v021 plugin add ...`。

### S4 确认组合与依赖代

```powershell
pnpm dsh --profile v021 --dump-config > D:\prj\dshopencodego\scratch\v021-dump-after.txt
Select-String dshopencodego D:\prj\dshopencodego\scratch\v021-dump-after.txt
```

- 预期 dump 里出现 `@dan-ai-studio/dshopencodego` 的 bundle 层与 patch 层。
- 在 profile 的 `node_modules` 里抽查实际解析到的代：
  ```powershell
  Get-Content "$env:USERPROFILE\.dsh\profiles\v021\node_modules\@deepseek-ai\cordis\package.json" | ConvertFrom-Json | Select-Object version
  Get-Content "$env:USERPROFILE\.dsh\profiles\v021\node_modules\@earendil-works\pi-ai\package.json" | ConvertFrom-Json | Select-Object version
  ```
  pi-ai 的版本由**本插件**提供（直接依赖），cordis 由宿主提供——两者都应符合 §0 的目标代。

### S5 配默认模型（推荐）

把下面条目追加进 `~\.dsh\profiles\v021\cordis.patch.yml`（值以 S4 的 dump / 日常 profile 实际配置为准）：

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: opencode-go
    model: deepseek-v4.1-flash
    reasoningEffort: max
```

### S6 启动并记录注册日志

```powershell
cd D:\git\deepseek-harness
pnpm dsh --profile v021
```

- 必须出现：`dshopencodego: route "opencode-go" registered as OpenCode Go`。
- 必须**不**出现：`not registering the "opencode-go" route — another adapter already owns it`。
- 记录任何 `could not refresh .../models`、`models this build cannot configure`、`unusable replay state` 警告——
  这三条分别对应目录降级、无法配置的模型、replay 退化，是本适配最可能出问题的地方。

### S7 UI 检查点

1. 设置页左侧出现「OpenCode Go」分区；API Key 显示已配置（凭据来自全局库）。
2. 模型区列出目录与计数；「刷新」可用；「目录刷新（分钟）」可改并写回。
3. 逐模型开关可切换；弃用模型默认关。
4. 会话输入框右侧出现「OpenCode Go 用量」按钮：三窗口 + 「自本次 Harness 启动以来」计数。
5. 顺带确认 0.2.1 的设置页改版（`640e28cd94` 重组插件设置 + 实验目录页）没有挤掉本分区。
6. **qwen 协议迁移专项**：pi-ai 1.0.x 把 `qwen3.7-plus` / `qwen3.8-max` 从 openai-completions
   挪到了 anthropic-messages。若 live listing 里出现这两个 id，各发一条消息确认真的能通；
   若只有其中一个协议可用，把观察结果记进 S12（这决定内置目录兜底是否需要 `modelProtocols` 覆盖）。

### S8 会话头抓包（判据 5）

```powershell
# 终端 A（仓库根）
cd D:\prj\dshopencodego
node tools\verify\recording-proxy.mjs 8787 scratch\v021-proxy.jsonl
```

- 在 `v021/cordis.patch.yml` 的插件条目里临时加 `baseURL: http://127.0.0.1:8787/zen/go/v1`，重启 dsh。
- 发 **3 条以上**消息（含一次工具调用），然后检查：
  ```powershell
  Get-Content scratch\v021-proxy.jsonl | ForEach-Object { $_ | ConvertFrom-Json } |
    Where-Object { $_.url -like '*chat/completions*' -or $_.url -like '*messages*' } |
    ForEach-Object { [pscustomobject]@{ at=[datetimeoffset]::FromUnixTimeMilliseconds($_.at).ToLocalTime().ToString('HH:mm:ss.fff'); url=$_.url; session=$_.headers['x-opencode-session'] } } |
    Format-Table -AutoSize
  ```
- 判据：`session` 非空；同一会话内所有请求**完全相同**；换会话后变化。
- 验证后**移除该 baseURL 条目**并重启。

### S9 流式终止语义（判据 6，0.2.1 专项）

先在小配置下做：把 `streamIdleTimeoutMs` 调到 `20000`（20s），重启 dsh。

**S9-a 连接被 kill**：S8 的代理运行时，从代理侧 `Ctrl+C` 或 `taskkill` 掉代理进程，然后发一条消息。
- 期望：Harness 侧出现**终态**错误（`TRANSPORT` / `ABORTED` 一类），UI 不转圈，不超过空闲超时。
- 失败样貌：请求永远挂着、UI 一直等待 —— 这正是 `dbb150ff0e` 要修的行为，若复现请记录完整时间戳与模型。

**S9-b 上游黑洞**（接受连接但不响应）：

```powershell
# 终端 B：一个永远不响应的本地 HTTP 服务
node -e "require('node:http').createServer(()=>{}).listen(8788,'127.0.0.1',()=>console.log('blackhole on 8788'))"
```

- 把 `baseURL` 改成 `http://127.0.0.1:8788/zen/go/v1`，重启，发一条消息。
- 期望：约 20s 后以 `TIMEOUT`（`LLM_STREAM_IDLE_TIMEOUT`）结束，错误文案含 idle timeout。
- 若挂起超过 60s 或永不返回 → **记录为阻断性缺陷**，这是 P2-7 的实机判据。

### S10 目录降级（判据 7）

沿用 S9-b 的黑洞 baseURL（或直接把 host 指到不存在的地址）：
1. 设置页点「刷新」→ 期望看到失败提示，但模型列表**仍显示**上一次的已知集合。
2. 启动日志应出现 `could not refresh .../models; using the last known model data`，且**没有**崩溃。
3. 恢复正确 baseURL，再刷一次 → 列表恢复 live。

### S11 route 生命周期（判据 8，cordis 4.0.5 专项）

1. 配置里把插件 `enabled` 改 `false` 并保存 → 期望日志 `disabled by configuration; the route and its models are withdrawn`，模型选择器里路线消失。
2. 改回 `true` → 路线与模型回来，且**没有** `another adapter already owns it`、没有重复的 registered 日志。
3. 反复 3 次，确认无泄漏迹象（`~/.dsh/logs` 无递增的未释放告警）。

### S12 归档结果

新建/更新 `docs/verification-0.2.1-live.md`，记录：
- DSH tag 与提交、插件提交号、tarball 名；
- §1 八条判据逐条的实际结果（过/不过 + 证据路径）；
- 抓包输出中 `x-opencode-session` 的实际样子；
- S9 两次中断的**实测耗时**（这是唯一能把"挂起"变成数字的办法）；
- 发现的任何异常与截图路径；
- 「未覆盖」的遗留项（例如未测 headless / SDK / ACP profile）。

### S13 收尾

- `Ctrl+C` 关闭 dsh；关闭代理与黑洞服务。
- 删除 `~\.dsh\profiles\v021`（需授权，见 §4）；保留 `scratch/` 与 tarball（gitignore）。

## 3. 回滚

- 任一步失败/中止：删 `~\.dsh\profiles\v021` 即回到起点；日常 `web` profile 全程未动。
- DSH 检出的恢复：
  ```powershell
  cd D:\git\deepseek-harness
  git checkout (Get-Content D:\prj\dshopencodego\scratch\dsh-original-branch.txt)
  ```
- 插件侧：本 runbook 不改动插件源码，分支 `chore/upgrade-dsh-0.2.1-alpha.2` 保持可弃。

## 4. 授权清单（执行前逐项确认）

| # | 动作 | 位置 |
|---|---|---|
| A | 打包并安装本地 tarball 到隔离 profile | `~\.dsh\profiles\v021` |
| B | 运行 dsh 产生会话、日志、附件 | `~\.dsh\{sessions,logs,attachments}` |
| C | DSH 检出 `git checkout` 到 tag 再切回 | `D:\git\deepseek-harness` |
| D | 结束后删除 `v021` | `~\.dsh\profiles\v021` |
| E | 本地监听 127.0.0.1:8787/8788 | 本机端口 |
| F | 仓库内：`scratch/`、tarball、验证文档 | `D:\prj\dshopencodego` |

## 5. 坑与注意

- **别用远程 URL 装 tarball**：已有缓存 profile 会报 `ERR_PNPM_MISSING_TARBALL_INTEGRITY`，用本地路径。
- **tarball 名以 `npm pack` 实际输出为准**：本分支 `package.json` 未 bump（仍是 0.1.20），历史文档里写死的资产名（0.1.0）已不可信。
- **`v021` 是模板 profile**（有 app 包）；若启动后无输出，先用 `--dump-config` 确认 bundles 里有 `dsh-web-app`。
- **S9/S10 会改 `baseURL`**：每改一次都要重启 dsh；验证完立刻改回，避免后续步骤在错误端点上跑。
- **S9-b 的黑洞服务要能退出**：它占着 8788，卡住时 `Get-NetTCPConnection -LocalPort 8788` 找 PID 再 `taskkill /PID <pid> /F`。
- 若日常 `web` profile 的默认模型不是 `opencode-go/deepseek-v4.1-flash`，以 S4 dump 的实际值为准，不要照抄 §S5。
- 浏览器 UI 文案以实际界面为准；本文引用的中文文案取自 `src/client/locales.ts`。
