# 需求：DSH 0.2.1-alpha.3 适配与接口跟进

- **状态**：已定稿，待执行
- **日期**：2026-10-15
- **适用对象**：`@dan-ai-studio/dshopencodego` v0.1.21
- **开发计划**：`docs/plan-0.2.1-alpha.3.md`（阶段划分与完成判据）
- **任务清单**：`docs/tasks-0.2.1-alpha.3.md`（可执行任务 T-01 ~ T-23）
- **术语**：见 `CONTEXT.md`；既有架构决策见 `docs/adr/`
- **上游版本**：DeepSeek Harness `0.2.1-alpha.3`（checkout `D:\git\deepseek-harness`，commit `571902028a`，tag `dsh-v0.2.1-alpha.3`）

## 1. 背景

用户 DSH 运行时是从源码 checkout 直接启动的（进程命令行 `node --import tsx/esm apps/cli/src/bin.ts web`），因此运行时版本即 checkout 版本 `0.2.1-alpha.3`；插件侧 devDependencies 仍锁在 `0.2.1-alpha.3` 之前的 `0.2.1-alpha.2`。需要判定插件是否需要重新适配，并处理调查中暴露的若干缺陷与上游接口变化。

本次调查已完成的**兼容性结论**（下文 R 系列需求的事实基础，勿重复调研）：

| 结论 | 证据 |
|---|---|
| **DSH 兼容门禁不读 `engines.dsh`**，只比较 `peerDependencies` 中 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的范围，且用 `semver.satisfies(..., { includePrerelease: true })` | `D:\git\deepseek-harness\packages\boot\app-boot\src\plugin-compatibility.ts:75,77` |
| **门禁实测放行**：用 DSH 自身求值器对插件真实 manifest 求值 → `COMPATIBLE`，17 个 `dsh-*` peer 全部匹配 | 直接调用 `evaluatePluginCompatibility`，runtime = `0.2.1-alpha.3` |
| **代码层 0 条破坏性变更**：`typecheck` 与 `build` 在 alpha.3 下稳定 `exit 0` | `scratch/build-verify/raw/alpha3-typecheck.log`、`alpha3-build.log` |
| 插件 20 个 value/命名空间 API 符号在 alpha.3 **全部存在**；19 个相关包 `.d.ts` **零删除** | `scratch/api-audit/report.md` §3；`missing_in_a2=0` 证明无假阳性 |
| **`LlmAdapter` 抽象成员集合两版一致**（唯一抽象方法仍是 `stream`）；新增的 `imageRequestTarget` 带默认实现 | `D:\git\deepseek-harness\packages\llm\llm\src\index.ts:248` |
| 承载符号的文件中，8 个 UNCHANGED；`credentials/index.ts` 为纯 JSDoc；`llm/index.ts` 为纯新增 | `git diff dsh-v0.2.1-alpha.2..dsh-v0.2.1-alpha.3 -- <path>` |
| 插件**未使用** `@Remote` / `RemoteScope` 装饰器，因此 typert 的装饰器重构不影响本插件 | `src/**` grep 无命中 |
| 客户端侧对 DSH 包的 import **全为 type-only**，编译期擦除；运行时 `lib/client.js` 只 require `react` / `react/jsx-runtime` | `lib/client.js`；`lib/build-info.json` |
| 三个 client externals 在 alpha.3 仍是 web shell 的 platform baseline 单例 | `D:\git\deepseek-harness\packages\client\web\src\seed.ts:38-40`、`platform.ts:11-13` |
| **`cordis` 与 `schemastery` 的 alpha.1→alpha.2 源码零 diff**，唯一改动是 version 字符串 | `git diff ... -- vendor/cordis vendor/schemastery` |
| `engines.dsh` 当前**不被强制** | `D:\git\deepseek-harness\packages\util\package-manifest\README.md:93` |

**结论：业务代码无需任何改动；阻塞项全部在依赖声明层。**

## 2. 目标

1. 插件在 DSH `0.2.1-alpha.3` 下可**安装**（`npm install` 不再 ERESOLVE）、可**开发**（三关全绿）。
2. 消除已定位的测试不稳定与配置噪声。
3. 与上游最新文档接口口径对齐，并留下可复用的结论记录。

## 3. 非目标

- **不接入 OpenCode 免费层**。见 §7「已否决需求」。
- **不改 DSH 核心**（`D:\git\deepseek-harness` 只作只读参考，不做任何写入）。
- **不改 OpenCode 上游源码**（`D:\git\opencode` 内现有的本地未提交修改是本轮调查之外的产物，不由本需求处理）。
- 不移除 pi-ai 依赖，不改路由 id `opencode-go`。
- 不做运行时协议自动探测。

## 4. 开发边界

沿用 `docs/plan.md` §2a 的约束：**所有开发产物只写在本仓库 `D:\prj\dshopencodego` 内**。仓库外的写入需先获得明确批准并约定清理方式。

本轮调查已在仓库内产生只读产物，保留备查：

- `scratch/api-audit/report.md`（38 KB）
- `scratch/build-verify/report.md`（20 KB）+ `raw/`（51 份原始日志）+ `backup/`（package.json / package-lock.json 原始副本）

本轮调查**已还原**工作区：`git status` 干净，`package.json`/`package-lock.json` SHA256 与备份逐字节一致，`node_modules` 已回到 alpha.2 状态，零 alpha.3 残留。

## 5. 需求项

优先级定义：**P0** = 不做则必然失败；**P1** = 影响 CI/发布或对外可见；**P2** = 正确性/可维护性；**P3** = 优化，可不做。

### A 组：DSH 0.2.1-alpha.3 适配

| ID | 需求 | 验收标准 | 优先级 |
|---|---|---|---|
| **R-A1** | devDependencies 的 `@deepseek-ai/cordis` 由 `4.0.5-alpha.1` 升到 `4.0.5-alpha.2` | 改后 `npm install` 退出码为 0；`node_modules/@deepseek-ai/cordis/package.json` 的 version 为 `4.0.5-alpha.2` | **P0** |
| **R-A2** | `peerDependencies` 的 `@deepseek-ai/cordis` 枚举补上 `\|\| 4.0.5-alpha.2` | `semver.satisfies('4.0.5-alpha.2', <新范围>)` 为 `true`；`pnpm`/`npm` 不再报 unmet peer | **P0** |
| **R-A3** | runtime dependency `@deepseek-ai/schemastery` 由 `~3.18.5-alpha.1` 更新为 `~3.18.5-alpha.2` | 与 `dsh-settings@0.2.1-alpha.3` 的 peer 要求一致；`npm install` 无 unmet peer | **P1** |
| **R-A4** | devDependencies 中其余 19 个 `@deepseek-ai/dsh-*` 升至 `0.2.1-alpha.3` | `npm run typecheck && npm run build && npm test` 三关通过 | **P1** |
| **R-A5** | 修正 `engines.dsh` 范围，使其在标准 semver 语义下覆盖 `0.2.1-alpha.*` | `semver.satisfies('0.2.1-alpha.3', <新范围>)` 为 `true`（不加 `includePrerelease`） | **P2** |

**R-A1 事实依据**：全部 21 个 `@deepseek-ai/dsh-*@0.2.1-alpha.3` 的 `peerDependencies` 都要求 `@deepseek-ai/cordis: ~4.0.5-alpha.2`。保持 `4.0.5-alpha.1` 时 `npm install` 直接 `ERESOLVE` 退出 1；且陈旧 lock（lockfileVersion 3，硬锁 alpha.2 依赖树）会让增量解析同样失败，必须删 `node_modules` + `package-lock.json` 后全新 install。

**R-A2 事实依据**：现范围为 `4.0.2 || 4.0.3 || 4.0.4 || 4.0.5-alpha.1`（`package.json:74`），**不含** `4.0.5-alpha.2`。注意 `~4.0.5-alpha.1` 这种写法在此**也不匹配** alpha.2（prerelease tilde 语义），必须显式并列。门禁不检查 cordis（`plugin-compatibility.ts:75` 只过滤 `dsh` / `dsh-*`），故此项**不阻塞加载**，仅影响安装期告警与声明准确性。

**R-A3 影响面**：这是本轮**唯一对外可见、影响最终用户**的依赖变更。

**R-A5 事实依据**：现范围 `>=0.1.7-alpha.1 <0.2.0 || >=0.2.0-rc.1 <0.3.0` 在标准 semver 下**不匹配** `0.2.1-alpha.*`——因为 prerelease 版本只在范围中存在**相同 `[major,minor,patch]` 元组**的 prerelease 比较器时才参与匹配，而范围里带 prerelease 的比较器元组是 `0.2.0`，版本元组是 `0.2.1`。DSH 当前不强制该字段，故仅为声明缺陷。

### B 组：缺陷修复

| ID | 需求 | 验收标准 | 优先级 |
|---|---|---|---|
| **R-B1** | 消除 `npm test` 的并发竞态 flake | 以修复前的失败复现方法验证：连续 **20 次**完整 `npm test` 全部 `exit 0` | **P1** |
| **R-B2** | 测试不再依赖真实外部网络 | 断网（或屏蔽 `models.dev`）下 `npm test` 仍全绿 | **P1** |
| **R-B3** | 清理用户 profile 中空转的 `space-bunny-free` 开关 | `space-bunny-free` 不再出现在配置中，或确认其可见性开关指向真实存在的模型 | **P2** |
| **R-B4** | 修正 `src/go-limits.ts` 中 `space-bunny-free` 的限额标注 | 限额表不再包含 Go 端点不存在的模型 | **P2** |

**R-B1 事实依据**：alpha.3 下 18 次完整运行有 **2 次**失败（约 11%）。失败签名是「活体 catalog 读取间歇性返回空」：
- `tests/adapter.spec.ts` → `LlmError: opencode-go has no model "deepseek-v4-flash"` @ `src/adapter.ts:206`
- `tests/adapter-listing.spec.ts:72` → `expected [] to deeply equal ['aa-expensive']`

**已排除**（三重对照实验）：失败用例单独运行 **30/30 通过**；`--no-file-parallelism` **4/4 全通过**；24 路并发 gateway 压力测试 **0 失败**；跨文件 `globalThis` 泄漏探测显示隔离正常；`dsh-llm` 的 `attribution.ts` 两版未变。**alpha.2 基线 8/8 全绿**，故非既有失败。

**根因假设（未坐实，需在实现中确认）**：`tests/setup.ts:5` 使用 `vi.unstubAllGlobals()`，而 `tests/mock-gateway.ts:283` 是**直接赋值** `globalThis.fetch = stub`（非 `vi.stubGlobal`），两者语义不配对，在 28 文件并行调度下产生竞态。

> **诚实标注**：失败瞬间的底层错误原文未被捕获（插桩会改变时序）。alpha.3 是否「加剧」该 flake 也无法判定（alpha.2 8/8 vs alpha.3 16/18，样本不足以判显著）。实现 R-B1 时若选「加固 harness」而非「加 retry」，必须先复现失败再修。

**R-B2 事实依据**：fetch 插桩实测到真实请求 `OK https://models.dev/api.json status=200 in 3ms`（`scratch/build-verify/raw/diag-fetch-instrument.log:6`）。`docs/plan.md` §6 的铁律「单测不得发真实请求」在此已被违反。

**R-B3 事实依据**：用户 profile `C:\Users\z9n5\.dsh\profiles\web\cordis.patch.yml` 中 `modelVisibility.space-bunny-free: true`，但该模型**不在** Go 端点的 37 个模型内——实测 `POST /zen/go/v1/chat/completions` 返回 `400 Model is unavailable.`。插件 catalog 的成员资格**来自网关列表**（`src/catalog/index.ts:265` 遍历 `ids`），故该开关不产生任何效果。注意 `models.dev` 的 `opencode-go` provider **确实收录了** `space-bunny-free`（38 个模型，多出的正是它）——这是元数据源与实际端点的偏差，也是该配置得以「看起来有效」的原因。

### C 组：上游接口跟进

| ID | 需求 | 验收标准 | 优先级 |
|---|---|---|---|
| **R-C1** | 默认 `baseURL` 由 `https://opencode.ai/zen/go/v1` 迁到 `https://opencode.ai/inference/go/v1` | 迁移后 `/models` 与 `/usage` 行为与迁移前一致（模型集合逐条相同） | **P1** |
| **R-C2** | （可选）支持 Console 主端点 `https://opencode.ai/inference/v1` | 能列出 86 个模型并按各自协议调用 | P2 |
| **R-C3** | （可选）补齐会话亲和头以提升 prompt cache 命中 | 请求携带 `x-session-affinity`，取值与 `x-opencode-session` 一致 | P3 |
| **R-C4** | （可选）标注 Go 端点 3 个免费模型的额度耗尽兜底语义 | 设置页/限额表正确说明「额度用尽后仍可用」 | P2 |
| **R-C5** | 归档免费层调研结论，防止重复调研 | 本文档 §7 存在且结论与实测一致 | P2 |

**R-C1 事实依据（重要：非紧急）**：`zen` 与 `inference` 目前**是两个等价入口**。实测：
- `GET https://opencode.ai/zen/go/v1/models` → 200，37 个模型
- `GET https://opencode.ai/inference/go/v1/models` → 200，**同一批 37 个模型**（`created` 时间戳仅差 1 秒）
- `GET .../usage` 两个域名均 → 401（需凭证）
- `GET /zen/v1/models` 与 `GET /inference/v1/models` 均 → 200，**同样的 86 个模型**

上游文档已全面改用 `inference` 口径（`https://opencode.ai/v2/docs/console/go/` 的 Endpoints 表全部是 `https://opencode.ai/inference/go/v1/...`）。因此这是**预防性迁移**，`zen` 路径当前仍在服务。

**R-C3 事实依据**：OpenCode 客户端实际发送 8 个头（`x-opencode-session-id`、`x-opencode-parent-session-id`、`x-session-affinity`、`X-Session-Id`、`x-parent-session-id`、`User-Agent`、`x-opencode-project`、`x-opencode-session`、`x-opencode-client`），见 `D:\git\opencode\packages\core\src\session\model-request.ts:296-320`；其中 `x-session-affinity` 是亲和性/缓存路由键。但 Go 官方文档**只要求 `x-opencode-session`**，插件当前实现（`src/session-header.ts:23,44`）**已合规**，故此项仅为可选优化。

**R-C4 事实依据**：Go 端点上的免费模型为 `cat-jam-free`、`step-5-preview-free`、`longcat-2.5-preview-free`。匿名请求返回 `401 {"message":"Upstream request failed: Go requires a credential"}`——**要 Go 凭证，不是要 OpenCode 身份**。Go 官方文档明示：*"If you reach the usage limit, you can continue using the free models."*

## 6. 约束与不变量

1. **不得破坏既有不变量**（`docs/plan.md` §4）：每个推理请求携带 `x-opencode-session`、同会话值恒定、目录四级优先级阶梯、用量失败保留旧值。
2. **不得引入对 `D:\git\deepseek-harness` 或 `D:\git\opencode` 的写入**。
3. **依赖变更后必须重跑三关**（typecheck / build / test），并保留原始日志。
4. **测试不得新增真实网络依赖**（R-B2 反向约束）。

## 7. 已否决需求（含理由，防止重复调研）

| 被否决项 | 结论 | 实测证据 |
|---|---|---|
| **通过 `Authorization: Bearer public` 接入 OpenCode 免费层** | **不可行，且不建议绕过** | 见下方完整论证 |

**论证链（三层，全部实测）**：

1. **`public` 不是凭证**。zen 网关服务端把 `public` **主动降级为「无 key」**：
   `D:\git\opencode\packages\console\app\src\routes\zen\util\handler.ts:107`
   ```ts
   const zenApiKey = rawZenApiKey === "public" ? undefined : rawZenApiKey
   ```
   实测佐证：对 `deepseek-v4.1-flash-free` 分别发「不带 auth」「`Bearer public`」「`Bearer invalid-xyz`」，三者返回**逐字节相同**的 403。

2. **`allowAnonymous` ≠ 公开匿名通道**。`handler.ts:698-702` 对标记 `allowAnonymous` 的模型在无 key 时放行，`handler.ts:837` 将其计费源记为 `"free"`。但实测对 `/zen/v1/chat/completions` 请求 4 个免费模型（`cat-jam-free`、`space-bunny-free`、`deepseek-v4.1-flash-free`、`big-pickle`）**全部返回**：
   ```json
   {"error":{"type":"FreeTierError",
    "message":"OpenCode's free tier can only be used from within OpenCode."}}
   ```
   即 `allowAnonymous` 的语义是「OpenCode 客户端内免登录」，不是「互联网免登录」。

3. **判决逻辑闭源**。`FreeTierError` 与 `"from within OpenCode"` 在 `D:\git\opencode` 全仓库**搜不到**；仓库内无 `inference` 路由目录（只有 `zen/v1`、`zen/go/v1`），说明该判定由另一套未开源的服务执行。`handler.ts:110` 唯一读取的 `x-opencode-client` **只写入监控 metric（第 113-121 行），不参与授权**。

**结论**：这是**明确的访问控制**，非缺失校验。官方文档同时列有 **Known problematic clients** 表点名第三方客户端（DeepSeek Harness 在列），并声明 *"Traffic is monitored for abuse"*。伪造客户端身份可能危及**已付费的 Go 账号**，收益（几个免费模型）与风险不成比例。**本需求明确不做，且不安排任何试错性探测。**

**备选合规路径**（若后续仍需要更多免费额度）：
1. 使用 Go 端点已有的 3 个免费模型（已付费权益，额度耗尽后仍可用）；
2. 直接对接上游模型的官方免费额度（如 NVIDIA Nemotron 免费端点、Meta Muse Spark contributor tier），绕开 OpenCode 中间层；
3. 若持有有效 Console service account key，可实测免费模型是否放行——**此格尚未验证**（实测时用的均为无效 token）。

## 8. 遗留未确认项

| 项 | 状态 | 需要什么才能确认 |
|---|---|---|
| 测试 flake 的确切机制 | 未坐实 | 能在不改变时序的前提下捕获失败瞬间的底层错误 |
| alpha.3 是否加剧该 flake | 未判定 | 更大样本（alpha.2 8/8 vs alpha.3 16/18，不显著） |
| 有效 Console key 下免费模型是否放行 | 未验证 | 一个有效的 Console service account key |
| `/inference/*` 服务的客户端判定信号 | 闭源，不可知 | 无（该逻辑不在开源仓库） |
| `@earendil-works/pi-ai`（声明 `~1.0.2`，实装 `1.0.4`） | 未比对 | 属第三方，不属本次版本差异范围 |

## 9. 参考

- 兼容性审计报告：`scratch/api-audit/report.md`
- 实测报告：`scratch/build-verify/report.md`（含 51 份原始日志）
- 上游兼容门禁实现：`D:\git\deepseek-harness\packages\boot\app-boot\src\plugin-compatibility.ts`
- 上游 manifest 语义：`D:\git\deepseek-harness\packages\util\package-manifest\README.md`
- 网关服务端逻辑：`D:\git\opencode\packages\console\app\src\routes\zen\util\handler.ts`
- 官方文档：<https://opencode.ai/v2/docs/console/go/>、<https://opencode.ai/v2/docs/console/models/>、<https://opencode.ai/v2/docs/console/api/inference/>
