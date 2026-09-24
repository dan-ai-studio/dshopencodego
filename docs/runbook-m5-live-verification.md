# Runbook：M5 实机验证（隔离 profile）

日期：2026-09-25。写给执行者（人 + agent 均可）。目的：在真实 Harness 的浏览器界面里验证设置页与用量按钮（M5 缺口），并顺带验证图片输入。

**方案**：新建隔离 profile `m5web`（从 shipped `web` 模板初始化），装 v0.1.3 tarball 验证。**全程不动日常 `web` profile**，删掉 `m5web` 即完全回滚。

## 0. 前置事实（2026-09-25 只读探测所得）

| 事实 | 值 | 影响 |
|---|---|---|
| 运行入口 | 在 `D:\git\deepseek-harness` 下 `pnpm dsh ...`（script = `node --import tsx/esm apps/cli/src/bin.ts`） | 所有 dsh 命令按此形式；`dsh` 不在 PATH |
| 日常 `web` profile | bundles 含旧插件 `@dan-ai-studio/dsh-opencode-go`；`agent-default-model` = `opencode-go/deepseek-v4.1-flash`（用户层） | 本次不动；它也是最终切换时的替换对象 |
| 新 profile 模板 | shipped `web` = `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`；**不复制**日常 profile 的用户层 | 新 profile 需要自己配默认模型（或不配，在 UI 里选） |
| 凭证 | 全局 `~/.dsh/.credentials.yaml`，`OPENCODE_GO_API_KEY` 已存在 | `m5web` 无需重新配 Key |
| 插件登记 | DSH 在 pnpm 装完后对新增依赖声明 `dsh.bundle` 者自动写入 `dsh.profile.bundles`（reconcile） | `plugin add` 后应自动成为 bundle layer |
| 会话/日志 | 运行会新写 `~/.dsh/{sessions,logs,attachments}` | 属目录外写入，见 §4 授权清单 |
| Release 资产名 | `dan-ai-studio-dshopencodego-0.1.0.tgz`（tag v0.1.3） | 下载 URL 按此拼；这是"package.json 未 bump"的后果 |
| 图片能力 | `deepseek-v4.1-flash` 的 `input` 含 `image`（pi-ai 0.87.1 目录） | 图片验证用默认模型即可，不必换模型 |

## 1. 完成判据（两条都过才算过）

1. **M5**：浏览器里「OpenCode Go」设置页正常渲染、字段可读写；会话输入框右侧的用量按钮可用（三窗口 + 自启动统计）。判据要求是"组件测试 + 浏览器实测"，本条补上后半。
2. **图片输入**：一次带图片附件的真实对话得到回复（HTTP 200，用量计数增加）。

## 2. 动线

### S0 仓库内准备（无授权要求）

```powershell
cd D:\prj\dshopencodego
New-Item -ItemType Directory -Force scratch | Out-Null
# .gitignore 追加一行：scratch/
Copy-Item "$env:USERPROFILE\.dsh\profiles\web\package.json" scratch\web-profile-package.json.bak
Copy-Item "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml" scratch\web-profile-cordis.patch.yml.bak
```

`scratch/` 存现状快照与中间产物，不入库。以上两份备份是最终切换日常 profile（阶段 2，另行授权）时的回滚参照。

### S1 创建 `m5web`（写 `~/.dsh/profiles/m5web`）

```powershell
cd D:\git\deepseek-harness
pnpm dsh --profile m5web --from-default-profile web --dump-config > D:\prj\dshopencodego\scratch\m5web-dump-before.txt
```

- 预期：命令退出码 0；`~\.dsh\profiles\m5web\` 出现（`package.json` + `cordis.yml` + `cordis.patch.yml`）；dump 里只有 `dsh-base`、`dsh-web-app` 两层。
- 若 pnpm 把 `--profile` 当成自身参数：在 `dsh` 后加 `--`（`pnpm dsh -- --profile m5web ...`）。
- 失败处理：profile 目录已存在会报错，改名或删除（删除属清理动作，本次授权范围内）。

### S2 下载 Release tarball 并安装（写 `m5web` 的依赖）

```powershell
cd D:\prj\dshopencodego
Invoke-WebRequest -Uri "https://github.com/dan-ai-studio/dshopencodego/releases/download/v0.1.3/dan-ai-studio-dshopencodego-0.1.0.tgz" -OutFile release-v0.1.3.tgz
cd D:\git\deepseek-harness
pnpm dsh plugin --profile m5web add D:\prj\dshopencodego\release-v0.1.3.tgz
```

- 用**本地路径**装（远程 URL 进已有缓存 profile 会报 `ERR_PNPM_MISSING_TARBALL_INTEGRITY`）。
- 预期：pnpm 安装成功；无 `declares no dsh.bundle` 警告。

### S3 确认组合里出现插件

```powershell
pnpm dsh --profile m5web --dump-config > D:\prj\dshopencodego\scratch\m5web-dump-after.txt
Select-String dshopencodego D:\prj\dshopencodego\scratch\m5web-dump-after.txt
```

- 预期：dump 中出现 `@dan-ai-studio/dshopencodego` 的 bundle 层与 patch 层。
- 若未登记：手工把 `@dan-ai-studio/dshopencodego` 加进 `~\.dsh\profiles\m5web\package.json` 的 `dsh.profile.bundles`，重跑 dump 确认。

### S4 配默认模型（推荐；写 `m5web/cordis.patch.yml`）

把下面条目追加进 `~\.dsh\profiles\m5web\cordis.patch.yml`（内容复制自日常 `web` profile 的用户层，保持一致）：

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: opencode-go
    model: deepseek-v4.1-flash
    reasoningEffort: max
```

不配也能在 UI 模型选择器里手动选，但配了才能验证"默认模型 + 本插件路由"的组合。

### S5 启动并做 UI 验证

```powershell
cd D:\git\deepseek-harness
pnpm dsh --profile m5web
```

- 预期控制台出现注册日志：`dshopencodego: route "opencode-go" registered as OpenCode Go`。
  若出现 `not registering the "opencode-go" route — another adapter already owns it`：说明 `m5web` 组合里还有别的所有者，停下排查（模板里不该有）。
- 浏览器会打开 web UI（工作区根 = 运行目录 `D:\git\deepseek-harness`）。检查点：
  1. 设置页左侧出现「**OpenCode Go**」分区（order 20）。
  2. API Key 显示「**已配置**」（凭证来自全局库）。
  3. 「模型」区列出目录（≥34 个）、计数与「刷新」按钮可用；「目录刷新（分钟）」可改并写回。
  4. 逐模型开关可切换（弃用模型默认关）。
  5. 会话输入框右侧出现「**OpenCode Go 用量**」按钮：显示 5 小时 / 本周 / 本月三窗口与「重置」时间；「自本次 Harness 启动以来」计数。
- 把实际看到的结果（含任何异常与截图路径）记入 S9 的文档。

### S6 真实对话（普通 + 只读工具调用）

- 新会话，确认模型为 `opencode-go/deepseek-v4.1-flash`。
- 发 `只回复：pong`，预期回复 pong。
- 再让它做一次**只读**工具调用（如读 `D:\git\deepseek-harness\README.md` 的开头），确认工具调用完成且用量计数增加。
- 工作区是 DSH 检出：验证期间避免写文件。

### S7 图片输入

```powershell
cd D:\prj\dshopencodego
node -e "require('fs').writeFileSync('scratch/red-dot.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64'))"
```

- 在同一会话上传 `scratch\red-dot.png`，发 `这张图是什么颜色？`，预期回复红色类描述。
- 用附件真实会话即可；也可换成手边任意图片。

### S8（可选加分）抓包确认会话头

仅在愿意多做一步时做，已有构建产物层的 live 证据，Harness 内的完整证据补这一步：

```powershell
# 终端 A（仓库根）
cd D:\prj\dshopencodego
node tools\verify\recording-proxy.mjs 8787 scratch\m5web-proxy.jsonl
```

- 在 `m5web/cordis.patch.yml` 的插件条目里临时加 `baseURL: http://127.0.0.1:8787/zen/go/v1`，重启 dsh 并发一条消息。
- 检查 `scratch/m5web-proxy.jsonl` 最近一条 `/zen/go/v1/chat/completions` 请求头：`x-opencode-session` 存在且同一会话内稳定。
- 验证后**移除该 baseURL 条目**。

### S9 归档结果（仓库内）

新建 `docs/verification-m5-live.md`，记录：启动日志、UI 各检查点的实际结果、两条对话与图片的结果、发现的问题、以及"未覆盖"的遗留项。

### S10 收尾

- Ctrl+C 关闭 dsh。
- 清理（需授权，见 §4）：删除 `~\.dsh\profiles\m5web`，保留 `scratch/` 与 `release-v0.1.3.tgz`（gitignore，可随时删）。

## 3. 回滚

- 任一步失败/中止：删 `~\.dsh\profiles\m5web` 即回到起点；日常 `web` profile 与旧插件全程未动。
- 阶段 2（切日常 profile，本次不做）：`pnpm dsh plugin --profile web remove @dan-ai-studio/dshopencodego` → `pnpm dsh plugin --profile web add @dan-ai-studio/dsh-opencode-go@0.1.15`（registry 来源，lock 已证可解析）；`cordis.patch.yml` 无需改动（路由 id 相同）。

## 4. 授权清单（执行前需逐项确认）

| # | 动作 | 位置 |
|---|---|---|
| A | 新建 profile `m5web`（写 package.json / cordis.patch.yml / node_modules） | `~\.dsh\profiles\m5web` |
| B | 运行 dsh 产生会话、日志、附件 | `~\.dsh\{sessions,logs,attachments}` |
| C | 结束后删除 `m5web`（建议；也可保留） | `~\.dsh\profiles\m5web` |
| D | （可选 S8）本地监听 127.0.0.1:8787 的录制代理 | 本机端口 |
| E | 仓库内：`scratch/`、`.gitignore` 追加一行、下载 tarball、新增验证文档 | `D:\prj\dshopencodego` |

## 5. 坑与注意

- 别用远程 URL 装 tarball（`ERR_PNPM_MISSING_TARBALL_INTEGRITY`），用本地路径。
- `m5web` 是模板 profile（有 app 包），不是裸 profile；若 `dsh` 启动后无输出，先查 `--dump-config` 的 bundles 里有没有 `dsh-web-app`。
- 浏览器 UI 的文案以实际界面为准（本清单引用的中文文案取自 `src/client/locales.ts`）。
- 结束后若把 `m5web` 留着，它也会出现在 profile 列表里；不想留就删。
