# @dan-ai-studio/dshopencodego

让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 正常使用 [OpenCode Go](https://opencode.ai/docs/zh-cn/go/) 订阅：模型列表直接来自网关，且每个推理请求都携带网关要求的 `x-opencode-session`。

[English](README.en.md)

## 为什么需要它

原生 DSH 已经能连 OpenCode Go（`llm-pi-ai` 内置该 provider）。本插件补的是它**不提供**的那几件事：

| 能力 | 原生 DSH | 本插件 |
| --- | --- | --- |
| **实时模型目录** | 构建期快照：pi-ai 打包时生成的固定表，网关新增模型要等 pi-ai 发版 | 实时读取网关目录，多级回退 + TTL 缓存 |
| **额度窗口**（5 小时 / 本周 / 本月） | 无 | ✅ |
| **花费估算** | 无 | ✅ |
| **逐模型开关** `modelVisibility` | 无 | ✅ |

本插件为 `opencode-go` 路由提供自己的适配器，并提供用量与设置界面。

> **关于会话头**：Go 要求每个请求带稳定的 `x-opencode-session`，缺失即 `400 MissingSessionID`。这一项曾是本插件的原始存在理由，但 pi-ai 已于 2026-09-09（`561a2e06`）实现注入、`llm-pi-ai` 自动携带，因此**原生 DSH 现在也不会缺会话头**。本插件当前仍保留自己的实现（为缺失会话 id 的请求提供一次性 UUID 兜底），待该兜底进入上游后再收缩——评估过程见 [`docs/scope-review-2026-10.md`](docs/scope-review-2026-10.md)。

## 安装

前提：DSH `0.2.0` 系列（`0.2.0-rc.1` 及之后，见「兼容性」）；Node `^22.19.0 || >=24.0.0`；`dsh` 与 `pnpm` 可用。

> **路由互斥**：同一个 profile 里 `opencode-go` 只能由一个适配器提供。装本插件前请先卸载旧插件（`dsh plugin --profile <p> remove @dan-ai-studio/dsh-opencode-go`），或清空 `llm-pi-ai` 配置里名为 `opencode-go` 的 provider。否则插件会记录一条明确的占用诊断，路由不会注册（其余功能照常）。

> **桌面端用户**：DSH 桌面端不走命令行安装，安装、升级与卸载都在应用内 Plugins 页完成，见文末「桌面端（Electron 应用）」。

### 方式一：npm（推荐）

```sh
dsh plugin --profile web add @dan-ai-studio/dshopencodego@<版本>
```

**安装后确认真实加载**——`--dump-config` 证明不了这一点：

1. 启动输出里应出现插件自己的注册日志 `dshopencodego: route "opencode-go" registered as OpenCode Go`（`enabled: false` 时是 `dshopencodego: disabled by configuration; …`）。没有它就没加载——被版本门禁拒绝时，同一条输出流里会打印 `Plugin … is incompatible with dsh …`。
2. 没有 HMR 的 profile 安装后会回报 `restart-required`（`restartReason: no-hmr`）：**重启 DSH** 后插件才生效。
3. 日志位置：启动失败会把完整诊断写到 `$DSH_HOME/logs/startup-<时间戳>-<uuid>.log` 并打印该路径；`dsh plugin` 失败会打印 `dsh: plugin command failed; diagnostics: <路径>`（profile 下的 `.plugin-manager/logs/operation-*/pnpm.log`）。
4. 会话头是否真的发出去了：`node tools/verify/live-check.mjs --check-only` 是**零成本**本地预检，会打印本次将会携带的 `x-opencode-session` 与 `x-session-affinity`；去掉 `--check-only`、加 `--allow-live` 才会真发**一次**最小请求（花钱，规则见 `tools/verify/README.md`），脚本随后断言并打印 `OK x-opencode-session: <会话 id>`。

> `dsh --profile web --dump-config | grep dshopencodego` **不构成加载证据**：被门禁拒绝的插件行同样会出现在 dump 里（`packages/boot/app-boot/README.md`）。它只能证明"这一行被写进了组合"。

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

版本约束与 CLI 一致：桌面端内置的 DSH 要落在已声明并验证过的版本带内（`>=0.2.0-rc.1 <0.3.0`，见「兼容性」）。若插件导致启动失败，桌面端的原生恢复对话框可以一键**禁用第三方插件、备份 `cordis.patch.yml` 后重启**，不会把应用锁死。

## 配置

配置写在 profile 的 `cordis.patch.yml`：

```yaml
- id: dshopencodego
  name: '@dan-ai-studio/dshopencodego'
  config:
    enabled: true                            # false 仅撤下路由，插件保持挂载
    apiKeyEnv: OPENCODE_GO_API_KEY            # 默认值
    baseURL: https://opencode.ai/inference/go/v1    # 默认值（OpenCode Go 端点）
                                              # 只能是不带 query / fragment 的 http(s) 地址；写 ?x=1 会在保存配置时被拒
                                              # 也可指定为 https://opencode.ai/inference/v1（Console 主端点，含按量/免费模型）
    refreshMinutes: 60                        # 目录缓存时长，1 ~ 10080（7 天）
    streamIdleTimeoutMs: 300000               # 流空闲超时：两次流事件之间的最长静默（毫秒）
    keepAliveTimeoutMs: 600000                # 连接空闲保留：两次请求之间连接留多久（毫秒，1 ~ 1800000）
                                               # 每次收到回答后重新计时，所以常用时连接不会被断开；
                                               # 对话中每次停顿较久都要重新握手一次（约 200ms）
    imageBudgetPreset: dsh                    # 图片预算三选一：dsh / dshopencodego / pi-ai（默认 dsh，即宿主自带值）
    modelVisibility:                          # 逐模型开关；未写到的模型走默认规则（见「设置页里的模型列表」）
      glm-5: true
    modelLimits:                              # 逐模型容量覆盖
      kimi-k3:
        contextWindow: 262144
        maxTokens: 32768                      # 可选：该模型的输出上限
      some-legacy-model: null                 # 整条 null：该模型两个字段都显式回退到目录值
    modelProtocols:                           # 最后兜底：逐模型协议覆盖
      some-new-model: openai-responses        # 合法值只有 anthropic-messages / openai-completions / openai-responses
    pinnedAddresses:                           # 固定 IP：域名 → 地址（只对网关域名生效）
      opencode.ai: 104.18.32.47              # 可写 IPv4 或 IPv6；不合法或未设置时走系统 DNS
    requestLogEnabled: false                 # 请求日志总开关，默认关闭：打开后注册侧边栏入口与会话标签页；关闭后无入口，请求路径与没有该日志逐字节一致
    requestLogDebug: false                   # 排错详情：连接池事件与请求 UA；会话 id 始终完整记录
    requestLogMaxEntries: 200                # 最多保留条数，50 ~ 500，超限丢弃最旧的
    retryPolicy:                              # 可选：本路由的重试策略（由 dsh-llm-retry 执行）
      mode: normal                            # 也可用 always（对所有失败重试，maxRetries 被忽略）
      maxRetries: 2                           # 默认 5
      retryableCodes: [RATE_LIMIT, TIMEOUT]   # 可选：只对这些错误码重试（默认 RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT / EMPTY_RESPONSE）
      backoff:
        initialDelayMs: 500                   # 默认 500
        maxDelayMs: 10000                     # 默认 10000，上限 2147483647
        jitterRatio: 0.1                      # 默认 0.1，取值 0 ~ 1
```

**保存即校验**：上面这些约束在**写入 profile 时**就检查，不会拖到第一次请求——`baseURL` 必须是 http(s) 且不带 query/fragment；`refreshMinutes` 取值 1 ~ 10080；`keepAliveTimeoutMs` 取值 1 ~ 1800000；`requestLogMaxEntries` 取值 50 ~ 500；`modelLimits` 的每个字段都可以写 `null`，语义是"显式选回目录值"（`modelLimits.<模型>: null` 表示两个字段一起回退）；`modelProtocols` 只接受那三个合法值，写错会让该模型以"配置缺失"出现（开关关闭、不可选），而不是回退到猜测；`retryPolicy` 是联合类型（`normal` 读 `maxRetries`/`retryableCodes`/`backoff`，`always` 只读 `backoff`），未知字段会被拒绝。

API Key 通过 Harness 凭证库提供（引用名 `OPENCODE_GO_API_KEY`），也可以直接 `export OPENCODE_GO_API_KEY=...`。

**流超时**：`streamIdleTimeoutMs` 约束的是**两次流事件之间的最长静默**，不是请求总时长——长思考模型只要持续产出事件就不会被误判。默认 5 分钟，上限为 `2147483647`（约 24.8 天）。超时抛出 `TIMEOUT`（可重试类）。

**连接保留**：`keepAliveTimeoutMs` 决定**与网关的连接在两次请求之间保留多久**。计时器**每次收到回答后重新开始**，所以常用时连接不会被断开，它约束的只是两次请求之间的静默。默认 10 分钟。

- 背后的原因很实际：连接一旦被断开，下一次请求要重新做一次 TCP 与 TLS 握手，**到网关这一侧约 200 毫秒**，而这笔开销正好落在**下一轮的第一个 token 上**。对话里的停顿（读答案、思考、再打字）通常在 5 ~ 30 秒，正好跨过 HTTP 客户端默认的 4 秒，于是**几乎每一轮都在白付一次握手**。
- 这条只影响**固定了地址**（`pinnedAddresses`）的部署：没有固定地址时走的是系统自己的 fetch，本插件不加任何东西。
- 设置页里以**秒**显示与填写（毫秒的数字人读不出量级），存储时换算成毫秒。取值 1 ~ 1800000 毫秒。
- 空闲满这个时间之后，连接由连接池**自己回收**，不需要额外的清理机制（实际释放时间比设置值多约 2 秒，那是客户端在服务端给的期限之外自留的一点缓冲）。插件被卸载时，连接池也会**一并关掉**——它是插件的，不该留在机器上。

**请求日志**：默认关闭的逐请求记录，打开它才注册侧边栏入口与会话标签页；关掉它入口一并消失，请求路径与没有该日志逐字节一致。设置页"请求日志"分组里有总开关、排错详情开关（连接池事件与请求 UA，默认关闭）、保留条数（默认 200）。

- **两个入口，同一个页面**：
  - **侧边栏图标 → 主区域整页**：跨会话看全部请求。日志是进程级的数据，放在侧边栏最合理——位置固定、常驻可见，和 DSH 自己的插件管理器同一个范式。
  - **会话里的「请求日志」标签页**：就地看**本会话**的请求，回答"刚才那轮为什么慢"不用离开对话。
- 页面是一整页而不是浮层：标题、统计（请求数／失败数／平均耗时／平均首字／平均 tok/s／平均缓存命中／连接复用率）、筛选栏固定在上方，只有表格自己滚动。每行含时间、模型、会话、输入／输出／缓存、**缓存命中**、**tok/s**、首字、耗时与状态；点一行展开 HTTP 明细（方法、协议、地址、请求体大小、脱敏后的请求头、请求构成、结果与用量、推理拆分、缓存写入、单轮花费、内容跨度）。筛选有模型／结果／慢请求／会话，分组有会话／模型／结果；**点列头按该列排序**，再点一次反向。
- **tok/s** 是**首字到结束**这段解码窗口上的输出速率，口径与 Harness 自己的每轮读数一致（含推理 token）。没有 token 的请求没有速率——不编数。**突发推送同样没有速率**：网关把一整轮攒到最后一次性推过来时（推理模型常见：8 秒思考在 wire 上不可见，然后上百个 token 几毫秒内到达），内容跨度不足 100ms，算出来的"每秒几万 token"不是生成速度——显示为 —，也不计入平均。
- 会话列显示**会话标题**（标题来自会话目录；拿不到时回退显示 id，悬停可见完整 id）。会话筛选同时匹配标题与 id；按会话分组的组头同样显示标题。**点标题直接打开那个会话**（归档的打不开，会明说）。
- **缓存命中**是输入 token 里走缓存的占比（缓存读取／（未缓存输入＋缓存读取））。网关没报输入就没有占比——同样不编数。
- **输入列是未缓存的新增 token**：网关把整段 prompt 拆成"未缓存＋缓存命中"两部分上报，输入列只记新增的——同一会话前缀缓存全中时输入很小、缓存命中 100%，不是 bug。悬停列头有口径说明。
- **内容拆分**：明细里"请求体"下面跟一行"文本 X ／图片 Y"——图片是各去重后附件按 base64 估的占比（单张按路由的编码上限封顶），文本是总数减图片的剩余，两者恒等于请求体总数。图片 dominant 的请求一眼就能看出来。
- 会话 id **始终完整记录**（它是会话身份，不是凭据；截断后两个会话会读成一个）。
- 记录的是环形缓冲（超限丢最旧），进程重启即清；只读快照，不轮询，没人打开的页面零流量。
- 凭据永远不进记录：记录器根本不接收请求头参数，只收白名单里的会话 id 与 UA；失败的请求同样记一条（含错误码），中断到没有终端事件的不记（网关没报总数就不编数）。

**图片**：三个字段各管一层，超限的图片会被明确拒绝，而不是静默降质或丢弃：

| 预设 | 单张像素 | 单张字节（base64 前） | 整单字节（base64 后） |
| --- | --- | --- | --- |
| `dsh`（默认） | 2048×2048 | 1MB | 20 MiB |
| `dshopencodego` | 144 万像素 | 400 KB | 6 MiB |
| `pi-ai` | 2000×2000 | 4.5MB | 20 MiB |

模型自身不支持图片输入时，适配器会在发请求前就拒绝（`UNSUPPORTED_CONTENT`），不会把图发出去再等网关报错。

**输出上限**：调用方给了 `maxTokens` 就用它（仍受 `modelLimits` 的逐模型上限约束）；没给时由宿主按路由上限物化——该上限就是目录里的输出容量，或 `modelLimits` 覆盖后的值。

**工具声明**：每个请求都发送当前完整的工具列表。宿主提供的会话折叠历史（`toolHistory`）**故意不投影**：投影需要路由声明 `toolUpdate` 模式，而 models.dev 对本网关模型只声明"可调用工具"、没有声明该模式；凭空声明会让模型看到的东西悄悄改变。

**重试**：`retryPolicy` 是可选的，不写就用宿主默认。写了就由可选的 `dsh-llm-retry` 插件执行，配置错误在写入时报错而不是等到失败发生。

**固定 IP**：`pinnedAddresses` 把网关域名固定到一个地址，用来接入更近的边缘节点（系统解析到的边缘有时离得很远，而每个请求都要为那段距离付费）。

- **只改解析，不改域名**：请求里的域名、Host 头、TLS 的 SNI 与证书校验全部照旧，只有 socket 连到哪个地址被换掉。因此该地址必须能服务这个域名——证书是发给 `opencode.ai` 的。
- **只对网关域名生效**：键必须等于 `baseURL` 的域名（默认 `opencode.ai`）。其它名字不在本插件的请求路径上，写了不生效。`models.dev` 与厂商文档始终走系统 DNS。
- **作用范围**：模型 API 请求、网关 listing（`/models`）、`/usage` 读取——这三类都是发往网关的请求。
- **地址失效自动回退**：固定地址连不上时（连接被拒、路由不可达、TLS 握手失败），请求会用系统 DNS **重试一次**，并把这个地址记为失效，之后的请求直接走系统 DNS。**填错 IP 不会比不填更糟**：只有"请求还没发出去"才重试，已经送达的请求不会发第二遍。
- **不设置就是原样**：`pinnedAddresses` 为空时，插件用的就是系统自己的 fetch，不加任何东西。
- **非法地址被忽略**：写错的 IP（`1.2.3.256`、`010.1.1.1` 等）不会让请求失败，只是被忽略并回退系统 DNS。

设置页（**OpenCode Go → 固定 IP**）里可以直接填地址：填的是网关域名当前对应的那个键，非法地址当场拒绝，地址失效后页面会显示"已回退系统 DNS"。

## 模型是怎么判定的

一个模型"怎么调"由四级证据决定，先命中先赢：

1. **pi-ai 内置目录的精确条目**——给出协议与线怪癖（如 DeepSeek 的 `thinkingFormat`）。该目录**编译进插件产物**，版本随插件发版更新，不会在运行时自行变化。
2. **models.dev 的每模型 `provider.npm`**——`@ai-sdk/openai` → Responses，`@ai-sdk/anthropic` → Messages，缺省 → Chat Completions。
3. **家族规则**——`grok*`/`gpt*`/`muse-*` → Responses，其余 → Chat Completions。
4. **`modelProtocols` 覆盖**——永远最高优先。

网关的 `/v1/models` 只回答"有哪些模型"，不回答"怎么调"。被推断出来的模型会在设置页标注，判错时用 `modelProtocols` 覆盖即可。

## 一个常见疑问：官方增删模型后，需要等插件发版吗？

**不需要——模型列表是实时的。** 网关 `/v1/models` 是成员资格的唯一来源，每次刷新目录（默认 60 分钟缓存，或点「重新检查」）都会以它为准：

- 官方**新增**模型 → 下次刷新即出现，协议/容量若不在内置目录中则标为"推断"并可被 `modelProtocols` 覆盖；
- 官方**下线**模型 → 下次刷新即消失；
- 内置目录**冻结**在插件版本里，仅影响"怎么调"的推断质量，不影响"有哪些"。

网关**临时不可用**时，插件保留上次成功获取的列表并在页面上标注陈旧，同时在后台重试：重试由**5 分钟的退避**控制，而不是等满一个 TTL，所以网关恢复后 5 分钟内列表就会更新；网关持续不可用时，它只被问一次，不会每次模型请求都去问一遍。设置页的「重新检查」随时可以强制重验，不受这个退避限制。

只有当 pi-ai 内置目录**缺了某个模型的线怪癖**（如 DeepSeek 的 `thinkingFormat`）时，才需要等插件同步 pi-ai 的新版本——而模型本身早已可用。

## 设置页里的模型列表

设置页的「OpenCode Go」分区展示网关实时目录（数量随网关发布变化），并对每个模型给出：

- **上下文 / 输入 / 输出**（最大输入只有部分模型有官方数据）、**发布时间**、**单价 /1M**（来自 models.dev）、**Go 额度**；
- **Go 额度**：运行时从 OpenCode 官方文档抓取「使用限制 / 预估请求数」两张表（数据源是官方仓库里的 markdown 文件，主源 GitHub、备用 jsDelivr），跟随目录每 60 分钟刷新一次；抓取失败时保留上次成功的数据，从未成功过则使用**内置快照**并在页面上标注其转写日期（`src/go-limits.ts`，已冻结、不再手工维护）。文档结构变化会被识别为抓取失败而不会清空显示。
- **输入模态**：单独一行列出 models.dev 声明的输入方式（文本 / 图像 / 音频 / 视频 / PDF）。这是**模型自身的元数据**，不等于 DSH 能直传：DSH 的模型输入只原生支持文本与图像，音视频/PDF 走附件与工具读取路径；文档未声明时该行不显示。
- 筛选（按名称/ID、仅已启用、显示已弃用——**默认隐藏已弃用**）、排序（新发布优先 / 每月预估次数 / 输入单价 / 上下文 / 名称 / 已启用优先）；列表是唯一视图，逐模型纵向排列。

**默认开关规则**：`modelVisibility` 是**逐模型**的——写了 `id: true`/`id: false` 的模型按显式值走，**没写到的模型仍走默认规则**：默认启用**每月预估次数最高的 5 个**（跳过已弃用、无法配置、以及"贡献者版"这类以数据换折扣的模型），其余关闭。这份 top5 名单每轮目录刷新都会无条件重算，与是否写过显式条目无关。同一规则同时作用于模型选择器与设置页，两处不会出现不同答案。**后果**：一旦写过显式配置，网关新增的模型若不在 top5 内，下次刷新**不会自动可见**，要显式加一条 `id: true`。

## 用量

- **额度窗口**：`GET /usage` 返回 5 小时 / 本周 / 本月三个百分比，含重置时间与限流状态；失败时保留上次读数并标注陈旧，账号或端点变化时不保留。
- **实际消耗**：会话内按钮显示本进程自启动以来的调用次数与 token（输入/输出/缓存读），数据来自 provider 每次调用回传的 usage。网关不公布分模型 token，因此这里如实标注口径，不伪造分模型配额。
- **估算花费**：按 models.dev 的每百万 token 单价乘 provider 回传的 token 估算，**不是账单**——订阅端点（Go）下仅供参考，只有按量端点（Console）才有对账意义。单价随每次调用一起记录，目录刷新不会用新价重算已经花掉的 token；目录未单独给出缓存单价时，缓存部分**按输入价估算**（上界）。**没有单价的模型显示「未定价」并列出模型名，绝不以 0 冒充免费**；极小金额显示为 `<$0.0001`。
- **推理 token**：provider 报告的思考 token 是 `outputTokens` 的**子集**，因此单独显示但**不计入总量**（否则同一批 token 会被算两次）。未上报该项的模型不显示该行——那是「没有数据」，不是 0。

## 兼容性

**支持**：DSH `0.2.0` 系列（`0.2.0-rc.1` 及之后的正式版）与 `0.2.1` 系列。插件在 `engines.dsh` 与每个 `@deepseek-ai/dsh-*` 的 `peerDependencies` 上声明 `>=0.2.0-rc.1 <0.3.0-0`。

**不再支持 `0.2.0` 之前**：`0.1.7` 系列及更早的版本自 v0.1.36 起被移除支持——那段范围内的运行时接口与本插件当前依赖的接口已经不同，继续声明只会让门禁放行一个未经验证的组合。`0.1.8`、`0.1.9` 从未发布。

**机制（不是写死）**：DSH 在挂载插件前会读取插件 `package.json` 的声明，对**运行时的 DSH 版本**做 semver 判定（含预发布，即 `includePrerelease`）。判定分两级，先命中先赢：

1. **`engines.dsh` 优先且独占**：插件只要声明了它，就**只**由它决定，`peerDependencies` 完全不参与判定（DSH 源码 `packages/boot/app-boot/src/plugin-compatibility.ts`：命中 `engines.dsh` 即返回）。
2. 插件**没有**声明 `engines.dsh` 时，才逐个检查 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的 peer 范围。

判定结果：

- 满足 → 正常加载；
- 不满足 → **该插件行被禁用并打印原因**（`Plugin … is incompatible with dsh …`），其他插件不受影响；
- 需要冒险时可用**精确版本豁免**：`dsh plugin --profile <profile> allow-version <包>@<版本> --dsh-version <精确版本> --accept-risk`（只对该包与该精确版本生效）；`dsh plugin --profile <profile> version-exemptions` 可列出当前 profile 的豁免。

**本插件声明了 `engines.dsh`，所以生效的门禁就是它**；peer 范围是给读者与包管理器的声明，只在 `engines.dsh` 被删除之后才会接管判定。上界写成 `<0.3.0-0` 而不是 `<0.3.0`，正是因为判定含预发布：`<0.3.0` 会把 `0.3.0-rc.1` 这类**预发布版判为兼容**并放行，`<0.3.0-0` 才真正封住整条 `0.3.0` 线。`@deepseek-ai/cordis` 单独声明为 `4.0.4 || 4.0.5-alpha.1 || 4.0.5-alpha.2 || 4.0.5`——依次是 DSH `0.2.0-rc.1`/`rc.2`、`0.2.1-alpha.1`/`alpha.2`、`0.2.1-alpha.3`–`alpha.5`、以及 `0.2.1-rc.2` 所用的运行时（`4.0.2`/`4.0.3` 随 `0.2.0` 之前的支持一并移除）。

**声明范围之外**：`0.2.0-rc.1` 之前的所有版本、以及整条 `0.3.0` 线（含预发布）都会被拒绝加载。如果 DSH 侧接口兼容，可自行放宽或删除该插件的 **`engines.dsh`** 后重新构建（改 peer 范围是无效的——它不参与判定）；否则请等插件跟进发版。

### 版本绑定的注意事项

| 绑定层 | 声明 | 谁在把关 |
| --- | --- | --- |
| `engines.dsh` | `>=0.2.0-rc.1 <0.3.0-0` | **DSH 加载时的真门禁；声明了它，peer 判定被整体跳过** |
| `peerDependencies`（20 个 `@deepseek-ai/dsh-*`） | 均为 `>=0.2.0-rc.1 <0.3.0-0` | 仅当 `engines.dsh` 缺席时才接管；本插件声明了它，故当前不参与判定 |
| `@deepseek-ai/cordis` | `4.0.4 \|\| 4.0.5-alpha.1 \|\| 4.0.5-alpha.2 \|\| 4.0.5` | 同上（peer 通道） |
| `engines.node` | `^22.19.0 \|\| >=24.0.0` | 包管理器 |
| 已打包依赖 `@earendil-works/pi-ai` | `~1.4.0`（1.4.x 内），**打进产物**（devDependency） | 独立耦合：pi-ai 改请求构造即影响本插件的线上行为；其 opencode-go 内置目录同时是本插件的打底数据。打包后本插件**没有任何运行时依赖**，安装者不必再解析它 |
| 已打包依赖 `@deepseek-ai/schemastery` | `~3.18.5-alpha.2`，**打进产物**（devDependency） | 构建期依赖 |

维护时需要注意：

- **必选与可选之分**：21 个 peer（20 个 `dsh-*` 加框架 `cordis`）中 9 个标了 `optional`（`dsh-api-remotes`、`dsh-client-locale`、`dsh-client-store`、`dsh-client-ui-layout`、`dsh-client-ui-model-selection`、`dsh-client-ui-primitives`、`dsh-client-ui-settings`、`dsh-client-ui-sidebar`、`dsh-client-ui-slots`）；其余 12 个是运行时必需的——`cordis`、`dsh-attachment`、`dsh-brand`、`dsh-client-ui-conversation`、`dsh-client-ui-renderer`、`dsh-credentials`、`dsh-fs`、`dsh-launch-environment`、`dsh-llm`、`dsh-timeout`、`dsh-typert-protocol`、`dsh-typert-registry`。这 21 个当前都**不参与加载判定**（见上：`engines.dsh` 单独决定），它们的价值在于声明依赖并供包管理器与读者使用。其中 `dsh-llm` 是最重的一处耦合（源码 import 二十余处）。
- **名义范围 ≠ 实测范围**：声明范围是 `>=0.2.0-rc.1 <0.3.0-0`，本项目实际验证过的基线依次是 `0.2.0-rc.1`（开发依赖基线：门禁判定 + typecheck + 全量用例）、`0.2.0-rc.2`（同上 + `prepareCall` 代次冻结）、`0.2.1-alpha.3`（首个目标版本）、`0.2.1-alpha.4`（T-24）、`0.2.1-alpha.5`（T-26）与 `0.2.1-rc.2`（T-31，运行时升到 cordis `4.0.5`；上游契约层源码零变更）。范围内的其他版本没有逐个验证过。
- **上界就是跟版线**：`<0.3.0-0` 意味着 DSH 一旦发布 `0.3.0-0`（`0.3.0` 线的第一个预发布版），本插件必须同批发新版，否则所有用户加载失败。`tests/peer-coverage.spec.ts` 会同时断言下界接受已安装版本、上界拒绝 `0.3.0-0`，所以这条线漂移会在本地测试里先失败，而不是等用户加载失败。调整范围后用 `npm test` 验证即可（本地 mock 网关，零网络零 token）——范围以接口声明为准，不要用线上探测来"测"出一个范围。
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
| 日志成片出现 `Accessing non-existent property 'Allow' of module exports inside circular dependency` | 成因是 `pi-ai` 对 `partial-json` 的**具名导入**：Node 解析 CJS 的具名导出时会枚举其 exports，而该包内部 `index.js`/`options.js` 互相 require，读到尚未初始化的 `Allow` 就打印一次——**插件重载会让它成片出现**（重启后往往消失）。**自 v0.1.38 起从机制上消除**：`pi-ai` 与 `partial-json` 已**打包进产物**，Node 的 ESM→CJS 互操作不再参与，因此不存在"枚举读到未初始化属性"这一步（不是过滤，是让该路径不存在）。 |
| 超长工具调用（多 MB 参数）期间整个 DSH 进程卡顿 | 曾在 pi-ai `0.87.1` 上观测到逐 delta 重解析的固有开销（issue #9265 / PR #9461）。本插件不移植 DSH 的消费者侧补丁（ADR-0005）；当前自带依赖已是 `~1.4.0`，若仍复现则属上游行为，随其发版解决。 |

## 开发

```sh
npm ci
npm run lint        # oxlint：静态检查（发布流程也会跑，失败即阻断）
npm run typecheck   # host 与 client 两半
npm run build       # 先构建：产出 lib/index.js 与 lib/client.js
npm test            # 契约测试：真实 HTTP mock 网关，断言请求头/体、目录阶梯、用量
```

**顺序有讲究**：`npm run build` 要排在 `npm test` 之前——`tests/pack-contents.spec.ts` 会遍历 `exports` 的每个目标，`lib/` 存在与否决定这条检查是执行还是被跳过（不报错，但会少一层保护）。`package.json` 已移除 `prepare`，因此 `npm ci` 不会再替你隐式构建；三个 CI workflow 都显式跑了 `npm run build`。

测试覆盖配置校验、协议阶梯、网关与在线元数据、目录投影、适配器（三种协议的线上请求）、Remote 契约与服务、会话头不变量、用量窗口与计量、客户端控制器与用量组件、两半的挂载与登记、流空闲超时与中止的错误映射、验证脚本的退出码契约、以及几条**结构性不变量**（inject 声明与源码读取一致、peer 覆盖双向、README 与 manifest 一致、README 对上游的断言与实装的上游一致）。共 **59 个测试文件**——这个数字由 `tests/readme-consistency.spec.ts` 对着 `tests/` 目录校验，不会漂移。

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
