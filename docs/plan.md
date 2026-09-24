# 计划：@dan-ai-studio/dshopencodego

让 DeepSeek Harness 原生、完整地使用 OpenCode Go：网关新模型无需等插件发版即可用，且每个推理请求都携带稳定的 `x-opencode-session`。本计划是 17 轮拷问后的结论，决策依据见 `docs/adr/`，术语见 `CONTEXT.md`。

## 1. 交付物

一个全新的独立插件项目，仓库 `dan-ai-studio/dshopencodego`，包名 `@dan-ai-studio/dshopencodego`，通过 GitHub Release tarball 分发。安装后：

- 路由 `opencode-go` 由本插件提供（因此与旧插件 `@dan-ai-studio/dsh-opencode-go` 互斥，需先卸载）。
- 模型选择器里的模型来自**网关实时目录**，不是 pi-ai 的构建期快照。
- 每个推理请求带 `x-opencode-session: <DSH 会话 id>`。
- 设置页有 API Key、目录与刷新、逐模型开关与容量覆盖；会话内有用量按钮。

## 2. 非目标

- 不改 DSH 核心（`llm-pi-ai` 的 pin、补丁与 compat 门禁不在本次范围）。
- 不移植 DSH 对 pi-ai 的"工具参数增量解析"补丁（记入风险，后续按实测决定）。
- 不做运行时协议探测，不做跨会话按日期汇总，不发布 npm。

## 3. 决策一览

| 决策 | 结论 | 依据 |
|---|---|---|
| 与旧插件关系 | 从零重写，独立项目 | ADR-0001 |
| 线协议执行者 | 插件自带 `@earendil-works/pi-ai@0.87.1` | ADR-0002 |
| 路由 id | 沿用 `opencode-go` | ADR-0003 |
| 协议判定 | 四级优先级阶梯 | ADR-0004 |
| 会话头注入 | 插件自己注入（不依赖 pi-ai 的 wrapper） | `docs/verification-pi-ai-upgrade.md` |
| 会话头取值 | 原样发 DSH 会话 id；无 id 时一次性 UUID 兜底 | 本轮问答 |
| 设置命名空间 | 新命名空间 `dshopencodego` | 本轮问答 |
| 用量 | 端点三窗口 + 会话级持久统计 + 启动以来累计 | 本轮问答 |
| 分发 | GitHub Release tarball + CI | 本轮问答 |
| DSH 兼容 | 只保证 0.1.7 系列 + 声明式矩阵 + 运行时检查 | 本轮问答 |
| 验证 | 三层：mock 契约 / 安装冒烟 / 一次真实最小请求 | 本轮问答 |

## 4. 架构

```
Host（index.js）
├─ config.ts          Config 模式（refreshMinutes、baseURL、modelVisibility、modelOverrides…）
├─ catalog.ts         四级优先级阶梯 + 目录缓存（TTL 可配，设置页刷新可绕过）
│                     ├─ 网关 GET {base}/v1/models        （可用性）
│                     ├─ models.dev api.json              （能力/成本/弃用/协议提示）
│                     └─ pi-ai 内置 opencode-go 目录       （精确协议与 compat）
├─ adapter.ts         LlmAdapter：三种协议经 pi-ai 执行；注入 x-opencode-session + user-agent
├─ usage.ts           网关 GET {base}/usage（Bearer）→ 三窗口
│                     会话级统计：折叠会话内 assistant 消息的 usage（持久、可重建）
├─ usage-store.ts     启动以来的内存累计（明确标注"自本次启动"）
├─ remote.ts          Typert Remote：用量、目录刷新、模型开关读写
└─ index.ts           apply()：注册路由（含占用诊断）、模型发现、设置、Remote、用量
Client（client.js）
├─ Section.tsx        设置页：API Key、目录列表+刷新、refreshMinutes、逐模型开关、容量覆盖、推断/缺失标记
├─ UsagePill.tsx      会话内用量按钮（三窗口 + 本地会话统计 + 陈旧/重试语义）
└─ locales.ts         中英文文案
```

关键不变量（写成可断言测试）：

1. 每个推理请求（三种协议、标题生成、压缩、子代理、重试）都带 `x-opencode-session`。
2. 同一会话内该值恒定；无会话 id 的请求用一次性 UUID，不共享亲和。
3. 目录判定遵循四级阶梯；被覆盖的模型标注来源（精确/在线/推断/覆盖）。
4. 用量端点失败时保留上次成功值并标注陈旧，绝不把"不可用"显示成 0。

## 5. 里程碑

| # | 内容 | 完成判据 |
|---|---|---|
| M1 | 工程骨架：package.json、双 tsconfig、esbuild 构建、vitest、CI、LICENSE、README | `npm run build && npm test && npm run typecheck` 全绿 |
| M2 | 目录：四级阶梯 + 缓存 + 网关/models 与 models.dev 拉取 + 缺失/弃用语义 | 契约测试用本地 mock 网关覆盖全部四级与失败路径 |
| M3 | 适配器：三种协议经 pi-ai 执行 + 会话头不变量 + 图片/推理档位 | mock 网关断言请求头与体；三种协议各一条 |
| M4 | 用量与 Remote：三窗口 + 会话级折叠 + 启动以来累计 + Typert 契约 | Host 契约测试 + 客户端组件测试 |
| M5 | 客户端：设置页、用量按钮、i18n | 组件测试 + 浏览器实测（本机 GUI） |
| M6 | 交付：建仓、CI 发 Release tarball、隔离 profile 安装冒烟、一次真实网关验证 | 安装后路由注册、模型可选、真实请求 200 且抓包见到头 |

## 6. 验证计划（三层）

1. **契约层（零额度）**：本地 mock 网关断言——三种协议的请求头、目录四级判定、用量解析与失败保留、路由占用诊断、模型开关语义。
2. **安装冒烟**：打 tarball → 装进隔离 profile → 启动 → 断言路由注册、模型出现在目录、无客户端报错。
3. **真实层（一次，已授权）**：用凭证库里的 key 向 `https://opencode.ai/zen/go/v1/chat/completions` 发一个最小请求，确认 HTTP 200，并用本地抓包/拦截确认 `x-opencode-session` 值等于该会话 id。

## 7. 风险

| 风险 | 缓解 |
|---|---|
| pi-ai 0.87.1 缺少 DSH 的增量解析补丁，长工具调用有二次解析开销 | 记入 README；用真实长工具调用实测 CPU，必要时用 profile 级 `patchedDependencies` 提供补丁 |
| 路由被旧插件或 `llm-pi-ai` 配置占用 | 注册失败作为一等诊断输出，含占用者与处置建议 |
| 网关/在线元数据不可达 | 复用本次运行成功获取的目录，再退到 pi-ai 内置目录；设置页显示陈旧警告与原因 |
| DSH 0.1.8 改缝 | 只保证 0.1.7 系列；运行时版本检查，不匹配明确报错 |
| 启发式协议猜错 | UI 标注"推断"，配置可逐模型覆盖，错误信息指向覆盖项 |
