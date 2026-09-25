# @dan-ai-studio/dshopencodego

让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 正常使用 [OpenCode Go](https://opencode.ai/docs/zh-cn/go/) 订阅：模型列表直接来自网关，且每个推理请求都携带网关要求的 `x-opencode-session`。

[English](README.en.md)

## 为什么需要它

原生 DSH 接 OpenCode Go 有两个缺口，都不是配置能补的：

1. **模型列表是构建期快照**。DSH 的 `llm-pi-ai` 用 pi-ai 打包时生成的目录；网关新增模型后，要么等 pi-ai 发版，要么手工声明。
2. **没有会话头**。Go 自 2026-09-05 起要求每个请求带稳定的 `x-opencode-session`，缺失即 `400 MissingSessionID`；`llm-pi-ai` 只发静态 profile headers，无法按会话取值。

本插件为 `opencode-go` 路由提供自己的适配器，同时解决这两点。

## 安装

前提：DSH `0.1.7` 系列（见「兼容性」）；Node `^22.19.0 || >=24.0.0`；`dsh` 与 `pnpm` 可用。

> **路由互斥**：同一个 profile 里 `opencode-go` 只能由一个适配器提供。装本插件前请先卸载旧插件（`dsh plugin --profile <p> remove @dan-ai-studio/dsh-opencode-go`），或清空 `llm-pi-ai` 配置里名为 `opencode-go` 的 provider。否则插件会记录一条明确的占用诊断，路由不会注册（其余功能照常）。

> **桌面端用户**：DSH 桌面端不走命令行安装，安装、升级与卸载都在应用内 Plugins 页完成，见文末「桌面端（Electron 应用）」。

### 方式一：npm（推荐）

```sh
dsh plugin --profile web add @dan-ai-studio/dshopencodego@<版本>
```

安装后确认组合里出现该插件：

```sh
dsh --profile web --dump-config | grep dshopencodego
```

### 方式二：GitHub Release

```sh
dsh plugin --profile web add https://github.com/dan-ai-studio/dshopencodego/releases/download/v<版本>/dan-ai-studio-dshopencodego-<版本>.tgz
```

### 方式三：本地构建

```sh
npm ci
npm run build
npm pack
dsh plugin --profile web add ./dan-ai-studio-dshopencodego-<版本>.tgz
```

> 用**本地路径**安装 tarball。把远程 tarball URL 装进一个已有缓存的 profile 会撞上 pnpm 的 `ERR_PNPM_MISSING_TARBALL_INTEGRITY`（见「故障排查」）。

### 升级与卸载

```sh
dsh plugin --profile web add <新版本 tarball 或包名>   # 升级
dsh plugin --profile web remove @dan-ai-studio/dshopencodego   # 卸载
```

> pnpm 对**同名本地 tarball** 会静默复用旧内容（`added 0`）。升级本地构建时请改文件名再装。

### 桌面端（Electron 应用）

DSH 桌面端是 Electron 壳 + 完整的 dsh Web 应用，本插件对它同样适用：host 半边是标准 bundle patch，client 半边声明的平台就是 `web`——桌面端渲染的正是这套 Web 客户端，设置页分区与会话内用量按钮来自同一批客户端包。桌面端使用**自己的 profile** `$DSH_HOME/profiles/desktop`，与 `profiles/web` 互不共享：凭证、模型可见性与插件设置都要在桌面端重新配一次。

安装**必须**走应用内界面，不要使用上面的 `dsh plugin` 命令：

1. 打开桌面端 → **设置 → Plugins（插件）** 页；
2. 安装规格填 `@dan-ai-studio/dshopencodego`（或指定版本，如 `@dan-ai-studio/dshopencodego@0.1.11`），确认安装；
3. 按提示**重启应用**，再到设置页填 API Key（引用名 `OPENCODE_GO_API_KEY`）。

原因：桌面端 profile 由 Electron 自己拥有，**CLI 不能启动也不能修改它**（桌面端 README 原文：*The CLI cannot boot or mutate this profile.*）。插件管理由应用内插件页经认证 HTTP API 完成，使用应用自带的 pnpm，不依赖 PATH 里的 `pnpm`；升级与卸载同样在 Plugins 页操作。

版本约束与 CLI 一致：桌面端内置的 DSH 要落在 `0.1.7` 线内（`>=0.1.7-alpha.1 <0.1.8`，见「兼容性」）。若插件导致启动失败，桌面端的原生恢复对话框可以一键**禁用第三方插件、备份 `cordis.patch.yml` 后重启**，不会把应用锁死。

## 配置

配置写在 profile 的 `cordis.patch.yml`：

```yaml
- id: dshopencodego
  name: '@dan-ai-studio/dshopencodego'
  config:
    enabled: true                            # false 仅撤下路由，插件保持挂载
    apiKeyEnv: OPENCODE_GO_API_KEY            # 默认值
    baseURL: https://opencode.ai/zen/go/v1    # 默认值
    refreshMinutes: 60                        # 目录缓存时长
    modelVisibility:                          # 逐模型开关（弃用模型默认关闭）
      glm-5: true
    modelLimits:                              # 逐模型容量覆盖
      kimi-k3:
        contextWindow: 262144
    modelProtocols:                           # 最后兜底：逐模型协议覆盖
      some-new-model: openai-responses
    retryPolicy:                              # 可选：本路由的重试策略（由 dsh-llm-retry 执行）
      mode: normal
      maxRetries: 2
      backoff:
        initialDelayMs: 500
```

API Key 通过 Harness 凭证库提供（引用名 `OPENCODE_GO_API_KEY`），也可以直接 `export OPENCODE_GO_API_KEY=...`。

**输出上限**：调用方给了 `maxTokens` 就用它（仍受 `modelLimits` 的逐模型上限约束）；没给时由宿主按路由上限物化——该上限就是目录里的输出容量，或 `modelLimits` 覆盖后的值。

**工具声明**：每个请求都发送当前完整的工具列表。宿主提供的会话折叠历史（`toolHistory`）**故意不投影**：投影需要路由声明 `toolUpdate` 模式，而 models.dev 对本网关模型只声明"可调用工具"、没有声明该模式；凭空声明会让模型看到的东西悄悄改变。

**重试**：`retryPolicy` 是可选的，不写就用宿主默认。写了就由可选的 `dsh-llm-retry` 插件执行，配置错误在写入时报错而不是等到失败发生。

## 模型是怎么判定的

一个模型"怎么调"由四级证据决定，先命中先赢：

1. **内置 pi-ai 目录的精确条目**——给出协议与线怪癖（如 DeepSeek 的 `thinkingFormat`）。
2. **models.dev 的每模型 `provider.npm`**——`@ai-sdk/openai` → Responses，`@ai-sdk/anthropic` → Messages，缺省 → Chat Completions。
3. **家族规则**——`grok*`/`gpt*`/`muse-*` → Responses，其余 → Chat Completions。
4. **`modelProtocols` 覆盖**——永远最高优先。

网关的 `/v1/models` 只回答"有哪些模型"，不回答"怎么调"。被推断出来的模型会在设置页标注，判错时用 `modelProtocols` 覆盖即可。

## 设置页里的模型列表

设置页的「OpenCode Go」分区展示网关实时目录（42 个起），并对每个模型给出：

- **上下文 / 输入 / 输出**（最大输入只有部分模型有官方数据）、**发布时间**、**单价 /1M**（来自 models.dev）、**Go 额度**；
- **Go 额度**来自 OpenCode 官方文档的「使用限制 / 预估请求数」表，**没有接口提供**，是本插件转写的数据表（见 `src/go-limits.ts` 的注释：来源 URL 与转写日期）；文档调整价格或促销时需要更新该表并随发版发布。
- **能力标记**：按 models.dev 的声明给每个模型加**结构化输出 / 温度控制 / 开源权重**徽标。只标注声明为"支持"的项——**未声明或声明不支持都不加标记**，与推理档位同一口径：不替文档下结论。
- **输入模态**：单独一行列出 models.dev 声明的输入方式（文本 / 图像 / 音频 / 视频 / PDF）。这是**模型自身的元数据**，不等于 DSH 能直传：DSH 的模型输入只原生支持文本与图像，音视频/PDF 走附件与工具读取路径；文档未声明时该行不显示。
- 筛选（按名称/ID、仅已启用、显示已弃用——**默认隐藏已弃用**）、排序（新发布优先 / 每月预估次数 / 输入单价 / 上下文 / 名称 / 已启用优先）；列表是唯一视图，逐模型纵向排列。

**默认开关规则**：没人显式配置过 `modelVisibility` 时，默认启用**每月预估次数最高的 5 个**（跳过已弃用、无法配置、以及"贡献者版"这类以数据换折扣的模型）；**一旦有任一显式条目，全部按显式值走**。同一规则同时作用于模型选择器与设置页，两处不会出现不同答案。

## 用量

- **额度窗口**：`GET /usage` 返回 5 小时 / 本周 / 本月三个百分比，含重置时间与限流状态；失败时保留上次读数并标注陈旧，账号或端点变化时不保留。
- **实际消耗**：会话内按钮显示本进程自启动以来的调用次数与 token（输入/输出/缓存读），数据来自 provider 每次调用回传的 usage。网关不公布分模型 token，因此这里如实标注口径，不伪造分模型配额。

## 兼容性

**支持**：DSH `0.1.7` 系列（含 `0.1.7-alpha.1`、`0.1.7-rc.*` 与正式版）。插件在每个 `@deepseek-ai/dsh-*` 的 `peerDependencies` 上声明 `>=0.1.7-alpha.1 <0.1.8`。

**机制（不是写死）**：DSH 在挂载插件前会读取插件 `package.json` 的 `peerDependencies`，对**运行时的 DSH 版本**逐个做 semver 判定（含预发布）：

- 全部满足 → 正常加载；
- 任一不满足 → **该插件行被禁用并打印原因**（`Plugin … is incompatible with dsh …`），其他插件不受影响；
- 需要冒险时可用**精确版本豁免**：`dsh plugin --profile <profile> allow-version <包>@<版本> --dsh-version <精确版本> --accept-risk`（只对该包与该精确版本生效）；`dsh plugin --profile <profile> version-exemptions` 可列出当前 profile 的豁免。

`package.json` 里的 `engines.dsh` 是本插件为读者/包管理器写的信息字段；**DSH 的兼容门禁只读 `peerDependencies`**，请以它为准。`@deepseek-ai/cordis` 单独声明为 `4.0.2 || 4.0.3 || 4.0.4`。

**0.1.8+ 或更早版本**：会被拒绝加载。如果 DSH 侧接口兼容，可自行放宽该插件的 peer 范围并重新构建（不改 DSH 核心）；否则请等插件跟进发版。

### 版本绑定的注意事项

| 绑定层 | 声明 | 谁在把关 |
| --- | --- | --- |
| `peerDependencies`（15 个 `@deepseek-ai/dsh-*`） | 均为 `>=0.1.7-alpha.1 <0.1.8` | **DSH 加载时的真门禁** |
| `@deepseek-ai/cordis` | `4.0.2 \|\| 4.0.3 \|\| 4.0.4` | 同一门禁 |
| `engines.dsh` | `>=0.1.7-alpha.1 <0.1.8` | 仅信息字段，DSH 不读 |
| `engines.node` | `^22.19.0 \|\| >=24.0.0` | 包管理器 |
| 自带依赖 `@earendil-works/pi-ai` | 精确锁 `0.87.1` | 独立耦合：pi-ai 改请求构造即影响本插件的线上行为 |
| 自带依赖 `@deepseek-ai/schemastery` | `^3.18.3` | 常规 semver |

维护时需要注意：

- **必选与可选之分**：15 个 peer 中 6 个标了 `optional`（`dsh-api-remotes`、`dsh-client-locale`、`dsh-client-store`、`dsh-client-ui-model-selection`、`dsh-client-ui-settings`、`dsh-client-ui-slots`）；真正卡住加载的是 9 个——`dsh-llm`、`dsh-typert-protocol`、`dsh-attachment`、`dsh-brand`、`dsh-credentials`、`dsh-fs`、`dsh-launch-environment`、`dsh-settings`、`dsh-timeout`。其中 `dsh-llm` 是最重的一处耦合（源码 import 二十余处）。
- **名义范围 ≠ 实测范围**：`0.1.7-alpha.1`、`alpha.2` 落在声明范围内，但本项目没有验证过；实际验证过的是 `0.1.7-rc.1`（开发依赖基线）与 `0.1.7-rc.2`（日常使用）。
- **上界就是跟版线**：`<0.1.8` 意味着 DSH 一旦发布 `0.1.8`，本插件必须同批发新版，否则所有用户加载失败。调整范围后用 `npm test` 验证即可（本地 mock 网关，零网络零 token）——范围以接口声明为准，不要用线上探测来"测"出一个范围。
- **peer 覆盖已双向守住**：`dsh-typert-registry`、`dsh-client-ui-conversation`、`dsh-client-ui-renderer` 曾被源码 import 却未声明、门禁管不到，现已补进 `peerDependencies`；`tests/peer-coverage.spec.ts` 双向断言——源码用到的必须声明，声明了却没人用的必须删（`dsh-settings` 就这样被移除：设置表单实际由 `dsh-client-ui-settings` 提供）。
- **豁免是按 profile 记的**：只有显式执行过 `dsh plugin allow-version` 的 profile 才享有豁免；没有记录就代表必须落在声明范围内。用 `dsh plugin version-exemptions` 可查看当前 profile 的豁免。

## 故障排查

| 现象 | 原因与处置 |
|---|---|
| 日志出现 `another adapter already owns it`，模型列表里没有本插件的模型 | `opencode-go` 路由被旧插件或 `llm-pi-ai` 配置占用。卸载占用者或清空其配置后重启。 |
| 设置页显示「未配置」但请求可用 | 旧于 v0.1.4 的构建有此缺陷（凭证结果未按信封解包），升级即可。 |
| 装包时报 `ERR_PNPM_IGNORED_BUILDS`（依赖构建脚本未批准） | 新建 profile 的 `pnpm-workspace.yaml` 里 `allowBuilds` 是占位文本；把 `@google/genai`、`protobufjs` 显式设为 `false`（二者不需要构建）后重装。 |
| 装远程 tarball 报 `ERR_PNPM_MISSING_TARBALL_INTEGRITY` | pnpm 对已有缓存的 profile 要求 lock 里有 integrity。把 tarball 下载到本地，用**本地路径**安装。 |
| 升级本地 tarball 后行为没变 | pnpm 对同名本地 tarball 会复用旧内容。改文件名再装。 |
| 设置页出现「设置写入被拒绝」 | 通常是与另一个窗口/进程并发写同一 profile；插件会自动重试一次，仍失败时界面已重载最新状态，再点一次即可。 |
| 用量按钮显示「不可用」 | 端点或凭证变化导致旧读数作废；配置正确后点「重试」。数值不会以 0 冒充。 |
| npm 发布报 `ENEEDAUTH` | OIDC 没匹配上：核对包设置里 Trusted Publisher 的 **workflow 文件名**（必须恰为 `publish-npm.yml`、大小写敏感）与组织/仓库字段；确认跑在 GitHub 托管 runner 上且工作流带 `id-token: write`。`package.json` 的 `repository.url` 与仓库不符也会被拒。 |

## 开发

```sh
npm ci
npm run typecheck   # host 与 client 两半
npm test            # 契约测试：真实 HTTP mock 网关，断言请求头/体、目录阶梯、用量
npm run build       # 产出 lib/index.js 与 lib/client.js
```

测试 148 个用例 / 24 个文件，覆盖配置校验、协议阶梯、网关与在线元数据、目录投影、适配器（三种协议的线上请求）、Remote 契约与服务、会话头不变量、用量窗口与计量、客户端控制器与用量组件、以及两半的挂载与登记。

## 发布（维护者）

1. **版本**：把 `package.json` 的 `version` 与即将打出的 tag 对齐（`v<版本>`）。CI 会校验资产名与 tag。
2. **GitHub Release**：提交并推送 `main`，打 tag 推送。`release.yml` 会跑测试、`npm pack` 并把 tarball 作为 Release 资产上传。
3. **npm（Trusted Publishing / OIDC，无需令牌）**：`.github/workflows/publish-npm.yml` 仅手动触发，认证走 GitHub Actions 的 OIDC——本仓库**没有也不需要** `NPM_TOKEN`。运行方式：

   ```sh
   gh workflow run publish-npm --repo dan-ai-studio/dshopencodego -f tag=v<版本>
   ```

   工作流会校验 tag 与版本一致、拒绝覆盖 npm 上已存在的版本，发布时**自动生成 provenance 声明**。它依赖 npm 包设置里的 **Trusted Publisher** 连接（字段一旦创建不可修改，要改只能删了重建）：

   | 字段 | 值 |
   |---|---|
   | Publisher | `GitHub Actions` |
   | Organization or user | `dan-ai-studio` |
   | Repository | `dshopencodego` |
   | Workflow filename | `publish-npm.yml`（完全一致、大小写敏感） |
   | Environment name | 留空 |
   | Allowed actions | 勾选 `Allow npm publish`（不勾则只允许 staged publishing：每次发布需人工 2FA 批准后才公开） |

   另外：OIDC 发布要求 **npm CLI ≥ 11.5.1 / Node ≥ 22.14**（工作流用 Node 24 满足）；`package.json` 的 `repository.url` 必须与 GitHub 仓库匹配。启用 OIDC 后，建议到包设置 → **Publishing access** 选择「Require two-factor authentication and disallow tokens」，并撤销不再需要的旧令牌。

## 许可证

MIT
