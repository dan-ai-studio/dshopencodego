# Changelog

本文件记录 `@dan-ai-studio/dshopencodego` 插件的所有重要变更。

## [0.1.33] - 2026-10-17

### 🐞 修复 (Fixes)

- **有插件管理器的组合却报「无法在此应用更新」**：v0.1.29 起，插件管理器通过一次性的 `ctx.get('remote.pluginManager')` 获取。Cordis 的 `get` 默认是 strict 的——当提供该服务的 fiber 尚未 `ACTIVE` 时返回 `undefined`，而插件 `apply` 期间正是这种状态。取到的那一次 `undefined` 被固化下来，页面便永久显示「当前组合没有插件管理器」（用户实测截图确认），一键更新因此完全不可用。
  现改为**响应式 `inject`**：由客户端入口在服务真正可用时填充一个持有对象（`PluginManagerHolder`），页面每次应用更新时读取其当前值。服务晚到也能自愈，缺失时仍如实降级为该提示。
- 新增回归用例：持有对象在页面构建时为空 → 报 `no-plugin-manager`；随后填充 → **同一控制器**可正常完成更新。静态声明测试的读取侧扫描同时扩展到任意接收者名（`managerScope.remote.…`），避免嵌套 inject 回调里的读取逃过检查。

---

## [0.1.32] - 2026-10-16

### 📖 文档 (Documentation)

- **补齐配置文档中缺失的四个字段**（中英双语 README）：`streamIdleTimeoutMs`、`maxRequestImageBytes`、`requestImagePixelBudget`、`requestImageMaxBytes` 在代码里一直有默认值与校验，但 README 从未列出，使用者只能读源码才能发现。
- 新增两段说明：**流超时**约束的是两次流事件之间的最长静默（而非请求总时长，故长思考模型不会被误判），以及**三个图片字段各管一层**（单图编码前字节 / 单图总像素 / 整请求 base64 后载荷）——附对照表，并说明不支持图片的模型在发请求前即被拒绝。

---

## [0.1.31] - 2026-10-16

### 🛠️ 内部优化与加固 (Internal Improvements)

- **依赖跟进到 DSH `0.2.1-alpha.4`（T-24）**：21 个 `@deepseek-ai/dsh-*` 开发依赖由 `0.2.1-alpha.3` 升至 `0.2.1-alpha.4`，`@deepseek-ai/cordis` 维持 `4.0.5-alpha.2`。已按 T-01 约定备份 `package.json`/`package-lock.json` 并记录 SHA256（`scratch/t24-backup/`），删除 `node_modules` 与锁文件后全新安装：258 个包、0 漏洞、无 ERESOLVE。运行时用的 peer 范围与 `engines.dsh` 本已覆盖 `alpha.4`，无需改动。
- **修复用量 pill 测试的时序脆弱性**：该用例只等待按钮出现，而按钮在读数返回前就已渲染（标签先是省略号），读数稍慢便断言到占位符而间歇失败（CI 上会表现为发布失败）。现改为等待**数据**而非元素，并新增一个刻意延迟读取的用例，使该等待契约每次都被执行。

---

## [0.1.30] - 2026-10-16

### 🐞 修复 (Fixes)

- **冷启动时缺失的模型不会被重新读取**（间歇性 `opencode-go has no model "…"`）：`forModel` 用“await 之后的快照是否仍等于 await 之前的缓存”判断要不要重验证，而在冷目录上缓存本就是空的，该比较恒为假，重验证被跳过——首次构建若恰好没带上某个模型（例如与模型列表/元数据抓取发生竞态），请求会直接以 `UNKNOWN_MODEL` 失败，而不是重读一次。现在只要快照无法服务该 id 且它也不在“已声明但无法配置”集合中，就重验证一次；这也解释了 `adapter.spec.ts` 长期存在的间歇失败。
- 新增两个针对性用例：冷目录收到未知模型时**必须**重验证，已能服务的模型**不得**重验证。两条用例在旧实现上分别呈现失败/通过，已确认其确实锁住该缺陷。

---

## [0.1.29] - 2026-10-16

### 🐞 修复 (Fixes)

- **一键更新会先卸载再失败，可能让插件消失**（严重）：预检把 `pluginManager.inspect` 的结果当作“有 `bundle` 字段即为安全”，但该结果是联合类型——`status: 'refused'`（例如网络不可达）**根本没有 `bundle` 字段**，判断因此落空，代码会径直卸载正在运行的版本；一旦随后的安装失败，用户将没有任何可用版本。现在预检明确区分三种结果：`refused` 与 `bundle: false` 都在动手之前中止并保留当前版本，只有确认通过才进入卸载步骤。
- **`inspect` 调用参数个数错误**：其描述符声明两个业务参数（spec 与 options），网关客户端会拒绝位置参数个数不符的调用，即使 `options` 在 TypeScript 里是可选的。现按描述符传两个参数。

### 🛠️ 内部优化与加固 (Internal Improvements)

- 测试中的 `pluginManager` 替身改为**严格校验位置参数个数**（与网关客户端一致），并新增“无法验证目标时绝不卸载”的回归用例；`inspect` 少传参数的错误此前只会在真实页面上暴露。

---

## [0.1.28] - 2026-10-16

### 🛠️ 内部优化与加固 (Internal Improvements)

- **不再把“查不到”说成“已是最新”**：registry 不可达时，Host 此前返回与“确认无更新”完全相同的读数，页面因此会显示“已是最新版本：x.y.z”——这是一句静默的谎话，与导致更新面板空白的缺陷同族。`UpdateStatus` 新增 `checked` 字段区分两者：未获得答复时页面显示“无法访问 npm registry，未获取到版本信息”并给出重试，不再冒充最新。
- **静态声明测试补全覆盖**：原测试只比对设置页的命名空间，现同时扫描客户端入口自身的 `scope.remote.*` 读取，确保入口文件里读取的命名空间也已声明（本次两处 inject 遗漏正是这类缺陷）。
- 其余审计项确认无须改动：Host 侧服务访问全部走宽松 `ctx.get()` 或已声明依赖；用量 pill 在页面隐藏时不轮询、失败保留旧读数并标 stale、读取超时 10s 小于 60s 轮询间隔，不会堆积请求。

---

## [0.1.27] - 2026-10-16

### 🛠️ 内部优化与加固 (Internal Improvements)

- **真正的根因：Cordis 的 inject 声明缺失**（0.1.23–0.1.26 的更新面板空白全部由此而来）。Cordis 对**未声明**的服务读取不是返回 `undefined`，而是抛 `cannot get property "…" without inject`（见 `vendor/cordis/src/reflect.ts`）。设置页读取 `remote.opencodeGoUpdate` 却从未声明它，首查即在客户端抛错，被面板的 catch 吞成永久空白。
- 同一缺陷的第二处：`remote.pluginManager`（一键更新用）同样未声明，按下“立即更新”必然失败。它改为通过宽松的 `ctx.get()` 获取而非必需依赖——插件管理器是独立宿主插件、组合可能不含它，声明为必需会让整个设置页在缺失时消失；缺失时仅一键更新给出可见说明。
- **新增静态一致性测试**（`tests/inject-declarations.spec.ts`）：比对设置页读取的 Remote 命名空间与客户端 inject 声明，遗漏即失败。该测试在落地时立刻抓出了上述第二个缺陷。真实框架行为也在 `tests/update-panel.spec.ts` 中以避免静默的方式锁定（失败必须可见）。

---

## [0.1.26] - 2026-10-16

### 🛠️ 内部优化与加固 (Internal Improvements)

- **修复更新面板在真实页面永远空白**（两个缺陷叠加，0.1.23–0.1.25 均受影响）：
  1. 检查失败时 phase 回落到 `idle`，而 `idle` 不渲染任何内容——于是**任何失败都不可见、也无法重试**；现改为进入可见的 `failed` 态并给出“重新检查”。
  2. 设置页在 catalog/credentials 可见时即构造 controller，而 `remote.opencodeGoUpdate` 排在同一个异步 mount 的末尾，首查时可能尚未注册，`undefined.readUpdate()` 抛 TypeError 后被 catch 吞掉——这正是“日志干净、刷新正常、就是没有横幅”的成因。现等待该 namespace 挂载（最多 2s，50ms 轮询），超时才报可见失败。
- 新增两个回归用例锁死上述行为（延迟挂载自愈、失败可见），并在 client bundle 中确认修复已随构建注入。

---

## [0.1.25] - 2026-10-16

### 🛠️ 内部优化与加固 (Internal Improvements)

- **修复更新检查在线上永远不触发**：`readUpdate(force)` 在线上传了位置参数，而手写描述符声明 `parameters: []`，网关客户端按 arity 直接拒收，页面静默保持无横幅。改为与目录 `read`/`refresh` 对齐的双方法（`readUpdate`/`refreshUpdate`，均零参），并以模拟网关 arity 检查的严格 fake 锁死该约定。

---

## [0.1.24] - 2026-10-16

### 🌟 对外可见变更 (User-Facing Changes)

- **更新状态常驻可见**：无新版时也显示“已是最新版本：x.y.z” + “重新检查”按钮，手动检查入口不再依赖横幅出现。

---

## [0.1.23] - 2026-10-16

### 🌟 对外可见变更 (User-Facing Changes)

- **设置页一键更新**：
  - 设置页打开时检查 npm 是否有新版本；有则显示横幅（新版本号、当前版本、更新说明链接）与“立即更新”按钮。
  - 点击后经二次确认，依次调用宿主 `pluginManager` 的 `inspect`、`removeBundle`、`installBundle`（与官方插件更新按钮完全相同的两步流程），无需手动卸载重装。
  - 插件自身绝不下载或替换自己的文件：清单锁、peer 兼容检查、构建审批与 HMR 生命周期仍归宿主；不兼容版本、待批准构建、需重启移除等情况均以指引文案呈现，绝不静默重试或自动豁免。

### 🛠️ 内部优化与加固 (Internal Improvements)

- **错误分类修正**：网关以 `429` + `"type":"server_error"` 上报上游不可用时，分类为 `SERVER` 而非 `RATE_LIMIT`（此前仅按状态码误判；两者均可重试，行为不变，诊断与遥测更准）。
- **回归锁定**：补 `reasoning_options` 缺席时沿用 installed level map 的用例；新 models.dev 形态（`budget_tokens`、空数组、混合）已有覆盖。

---

## [0.1.22] - 2026-10-15

本次发布针对 DeepSeek Harness `0.2.1-alpha.3` 运行时底座完成了依赖对齐、测试基础设施加固、无效配置清理与官方端点平滑迁移。

### 🌟 对外可见变更 (User-Facing Changes)

- **默认端点口径迁移 (R-C1)**：
  - 将默认网关 `DEFAULT_BASE_URL` 从 `https://opencode.ai/zen/go/v1` 迁移至官方推崇的 `https://opencode.ai/inference/go/v1`（详见 [ADR-0006](docs/adr/0006-endpoint-migration-to-inference.md)）。
  - 未显式配置 `baseURL` 的实例将自动指向新端点，经实测 `/models` 目录（37个模型）与 `/usage` 配额结构保持 100% 行为等价。
- **剔除无效模型配置 (R-B4)**：
  - 从预设配额表（`SEED_QUOTAS`）中剔除 `space-bunny-free`。OpenCode Go 官方端点当前并不提供该模型（实测调用返回 400 错误），历史收录源于第三方爬虫元数据偏差。
- **支持 Console 主端点 (R-C2 / T-21)**：
  - 新增导出 `CONSOLE_BASE_URL = 'https://opencode.ai/inference/v1'`。
  - 用户可配置 `baseURL: 'https://opencode.ai/inference/v1'` 接入 OpenCode Console 主端点，完整解锁 86 个按量与免费模型。
  - 内置健全的四级协议降级与家族推断，确保全量模型正确映射至 Chat Completions、Responses 或 Messages 协议，且在 Console 缺失 `/usage` 时平稳降级，保障系统稳定运行。
- **补齐会话亲和头 (R-C3 / T-22)**：
  - 导出 `SESSION_AFFINITY_HEADER = 'x-session-affinity'`，请求同时携带 `x-opencode-session` 与 `x-session-affinity`（同会话内取值严格一致），对齐上游官方行为，增强网关亲和路由与 Prompt Cache 命中率。
- **运行时环境兼容范围扩大 (R-A3, R-A5)**：
  - 更新 `package.json` 中的 `engines.dsh` 为 `">=0.1.7-alpha.1 <0.2.0 || >=0.2.0-rc.1 <0.2.1 || >=0.2.1-alpha.1 <0.3.0"`，在标准 semver 语义下无缝兼容 `0.2.1-alpha.*` 预发布版本运行时。

### 🛠️ 内部优化与加固 (Internal Improvements)

- **依赖对齐与升级 (R-A1, R-A2, R-A4)**：
  - 核心依赖对齐至 `@deepseek-ai/cordis@4.0.5-alpha.2`，20 个 `@deepseek-ai/dsh-*` 依赖升至 `0.2.1-alpha.3`，`schemastery@~3.18.5-alpha.2`。
  - 补全所有缺失的运行时 peer 依赖并配置可选元数据，全新 `npm install` 零 ERESOLVE 冲突。
- **单元测试零网络依赖与稳定性消除 Flake (R-B1, R-B2)**：
  - 固化 `models.dev` 真实元数据为本地离线 fixture，测试过程 100% 离线运行。
  - 全面重构 mock gateway 与全局 fetch 拦截机制，测试生命周期内彻底隔离全局污染，高并发下连续 20 次压测通过率 100%（20/20 全部绿灯）。

---

## [0.1.21] - 2026-09-29

- 适配 DeepSeek Harness `0.2.1-alpha.2`。
- 增强会话头注入与时钟生命周期管理。

## [0.1.20] - 2026-09-25

- 移除脆弱的 `postinstall` 增量解析补丁，拥抱上游行为（详见 [ADR-0005](docs/adr/0005-drop-pi-ai-patch.md)）。
