# Changelog

本文件记录 `@dan-ai-studio/dshopencodego` 插件的所有重要变更。

## [0.1.39] - 2026-10-17

### 🧹 清理 (Cleanup)

无功能变更。一次代码审计的结果：

- **修正已失效的构建说明**：`scripts/build.mjs` 头部仍写着"所有包都保持 external（pi-ai 与 schemastery 来自本包的 dependencies）"——自 v0.1.38 起二者已编译进产物，`dependencies` 也为空。说明与代码不符会误导后来者，尤其在一个"打包与否"正是关键决策的位置。
- **收回 21 个内部符号的导出**：它们在各自模块内被使用（不是死代码），但不在 `src/index.ts` 的公开导出列表中，`export` 只会让实现细节看起来像对外契约。涉及 `catalog/`、`client/Section.tsx`、`config.ts`、`models.ts`、`update/check.ts`、`usage/windows.ts`。
- **审计同时确认**（未发现问题）：无死代码——`tsconfig` 已开启 `noUnusedLocals`/`noUnusedParameters` 且 `target` 为 `ES2024`、`strict` 与 `exactOptionalPropertyTypes`、`noUncheckedIndexedAccess` 全部到位；所有 devDependency 均被引用；`dependencies` 为空；已删除代码（0.1.37 的警告过滤）无任何残留引用；`scratch/` 调查产物已被 gitignore，不进仓库也不进包。

### 📌 已知的依赖滞后（本次未动，需要时再评估）

`react`/`react-dom` 18 与 `@types/react` 18 落后于 19：**这三项必须跟随宿主**——Client 产物把 React 留给 DSH Web 的模块表提供，擅自升级只会让类型与实际运行时脱节。`@types/node` 22 对应 `engines.node` 的下限（`^22.19.0`），保持一致。可独立评估的是 `typescript` 6→7、`vitest` 4→5（含 `@vitest/coverage-v8`）、`jsdom` 29→30，三者都是大版本，属于独立任务而非本次清理。

---

## [0.1.38] - 2026-10-17

### 🔧 根本修复 (Root cause)

- **成片的 `Accessing non-existent property 'Allow' …` 从机制上消除**，取代 v0.1.37 的过滤做法。
  - **根因**：`pi-ai` 对 `partial-json` 用的是 ESM **具名导入**。Node 解析 CommonJS 的具名导出时会枚举该模块的 exports（`cjs-module-lexer` 的回退路径），而 `partial-json` 的 `index.js` 与 `options.js` 互相 require——在对方尚未初始化时读到 `Allow`，**每读一次打印一次**；插件重载会重新走一遍模块图，于是升级安装后成片出现，重启后消失。
  - **修法**：把 `pi-ai`（连同其依赖 `partial-json`）**打包进产物**。Node 的 ESM→CJS 互操作不再参与，**枚举这一步根本不存在**——不是把提示藏起来，而是让产生它的路径消失。
  - **体积代价被抵消**：`providers/all` 会载入**全部** provider 的模型数据（仅 `providers/data` 就有 991 KB）与所有厂商的 API 实现。改为按公开子路径导入（`providers/opencode-go.models`、`models`、`utils/overflow`、`utils/transcript`）后，产物为 **1.86 MB**（npm 包压缩后 **0.42 MB**）。原先外置时这些代码同样会被加载，**总量并未增加**。
  - **附带收益**：本插件**不再有运行时依赖**（`dependencies` 现为空），安装者不必再解析 `pi-ai`/`schemastery`，也不会因 profile 里 pi-ai 版本不同而产生行为差异。
  - **正确性依据**：换用 `OPENCODE_GO_MODELS` 前逐条比对过它与 `getBuiltinModels('opencode-go')` 的结果——29 个模型 id 完全一致，抽样记录逐字段相同。

### ↩️ 回退 (Reverted)

- **撤销 v0.1.37 的警告过滤**。按消息前缀丢弃一条警告是在**掩盖**问题，与本插件一贯坚持的"失败必须可见"相悖——v0.1.26（失败静默）与 v0.1.28（查询撒谎）两次修复正是为消除这类做法。产生警告的路径既然能移除，就不该把它藏起来。

---

## [0.1.37] - 2026-10-17

### 🔇 噪声治理 (Noise)

- **成片的 `Accessing non-existent property 'Allow' …` 警告不再出现**：`pi-ai` 对 `partial-json` 用的是**具名导入**，而解析 CJS 的具名导出会让 Node 枚举该模块的 exports；`partial-json` 内部 `index.js` 与 `options.js` 互相 require，于是在对方尚未初始化时读到 `Allow`，**每读一次打印一次**。插件重载会重新走一遍模块图，因此升级安装后往往成片出现，而重启后消失。
  - **无功能影响**：该警告只提示属性读取时机，`parse` 的行为已实测验证（部分 JSON 解析正确）。
  - 实现方式：按**消息前缀**精确过滤这一条。Node 发这条警告时**不带 type**（默认 `Warning`），因此 `--disable-warning=<code|type>` 无法选中它；前缀匹配是可用的最窄过滤，且只丢弃这一条消息，其余警告原样透传。
  - 安装时机为 `apply` 的第一条语句（ES 的 import 会被提升，`pi-ai` 在本 bundle 任何语句执行前就已求值，故首次枚举无法拦截——能被拦截的正是重载产生的那些）。标记存放在 `process` 上的 `Symbol.for` 键，插件被重新求值也不会重复包装。
  - 新增用例：消息识别（字符串与 `Error` 两种形态）、只丢弃该条、安装幂等、以及 `apply` 确实安装它。

---

## [0.1.36] - 2026-10-17

### 💥 破坏性变更 (Breaking)

- **不再支持 DSH `0.2.0` 之前的版本**：17 个 `@deepseek-ai/dsh-*` 的 peer 范围由 `>=0.1.7-alpha.1 <0.2.0 || >=0.2.0-rc.1 <0.3.0` 收敛为 **`>=0.2.0-rc.1 <0.3.0`**，`engines.dsh` 同步。`0.1.7` 系列及更早的运行时接口与本插件当前依赖的接口已经不同，继续声明只会让门禁放行一个从未验证过的组合。
- **`@deepseek-ai/cordis` 移除 `4.0.2`/`4.0.3`**：二者只被 `0.2.0` 之前的运行时使用。已按 DSH 逐版核对保留对应分支——`4.0.4` 对应 `0.2.0-rc.1`/`rc.2`，`4.0.5-alpha.1` 对应 `0.2.1-alpha.1`/`alpha.2`，`4.0.5-alpha.2` 对应 `0.2.1-alpha.3` 及之后。
- **低版本用户的影响**：运行 DSH `0.1.x` 的组合会因门禁判定不通过而**禁用本插件行并打印原因**（其他插件不受影响）。需要继续使用旧版 DSH 的用户请留在 v0.1.35。

### 📖 文档 (Documentation)

- README 兼容性章节重写（中英双语）：支持范围、cordis 三个分支各自对应的 DSH 版本、以及在范围内**实际验证过的基线**（`0.2.0-rc.1`、`0.2.0-rc.2`、`0.2.1-alpha.3`/`alpha.4`/`alpha.5`）。
- 源码中 5 处指代 `0.1.7` 的注释改为不带版本号的表述——它们解释的是当前行为，而版本号在停止支持后只会误导读者。
- 新增用例锁定该决策：peer 与 `engines.dsh` 不得再出现 `0.1.x`，cordis 不得再出现 `4.0.2`/`4.0.3`。

---

## [0.1.35] - 2026-10-17

### 🔄 打底数据同步 (Fallback data)

- **pi-ai `1.0.2` → `~1.3.0`**：其内置目录正是本插件的打底数据（协议阶梯的第一级与离线兜底）。旧目录已过时——官方文档当前列出的模型与 1.3.0 内置目录高度吻合，而 1.0.4 停留在一个更早的集合上。同步后：
  - **新增** `cat-jam-free`（`openai-completions`）、`claude-haiku-5-5`（`anthropic-messages`）、`gemini-4-argon-contributor`、`space-bunny` 的内置协议；
  - **移除** `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`、`grok-4.6`、`minimax-m2.7`、`space-bunny-free` —— 官方文档确认这些已不在 Go 端点。
  - 已验证类型检查与全部测试通过；`adapter.spec.ts` 中一个用例原先拿 `deepseek-v4-flash` 当样本，该模型已下线，改用仍在目录中的 `deepseek-v4.1-flash`。

### 🐞 修复 (Fixes)

- **不受支持的线协议会被当成可用模型列出**：`metadata.ts` 把内置目录的 `api` 用 `as WireProtocol` **裸断言**，绕过了本已存在的 `asWireProtocol` 守卫。pi-ai 1.3.0 把 `gemini-4-argon-contributor` 标为 `google-generative-ai`（第四种协议，`buildProvider` 并未挂载该实现），于是该模型会以最高可信度来源 `builtin` 进入模型列表、`unavailable` 为空，直到用户发起流式请求才失败——正是本插件一贯拒绝的「静默的谎话」。
  现在内置协议先经守卫（不再是裸断言），且 `assemble` 对「目录声明了本插件无法实现的协议」的 id 直接归入 `unavailable` 并给出原因（`its wire protocol "…" is not implemented by this plugin`），其余模型不受影响。新增用例覆盖该拒绝行为。

---

## [0.1.34] - 2026-10-17

### 🛠️ 内部优化与加固 (Internal Improvements)

- **依赖跟进到 DSH `0.2.1-alpha.5`（T-26）**：21 个 `@deepseek-ai/dsh-*` 开发依赖升至 `0.2.1-alpha.5`（cordis 维持 `4.0.5-alpha.2`）。全新安装 258 包 / 0 漏洞，三关全绿。先核对过上游：`llm`、`typert`、`settings`、`client` 等契约层**源码零变更**（仅版本号），因此**无需适配**。
- **README 兼容性表修正四处漂移**：该表是读者判断兼容性的依据，却已过期——`pi-ai` 仍写着"精确锁 `0.87.1`"（实际 `~1.0.2`，差三个大版本）、cordis peer 少了 `4.0.5-alpha.1/alpha.2` 两个分支（DSH `0.2.1-alpha.3`+ 实际使用）、`engines.dsh` 少了 `0.2.1-alpha` 段、`schemastery` 写作 `^3.18.3`（实际 `~3.18.5-alpha.2`）。中英双语同步修正。
- **新增 README 一致性测试**：从 `package.json` 读取声明，逐条断言兼容性表**对应表格行**的内容（中英各一份）。断言精确到行而非整篇——整篇 `toContain` 曾因版本串在故障排查节里再次出现而放过了漂移；测试有效性已通过临时回退验证。
- **插件管理器持有对象补齐清理**：`inject` 回调返回 disposer，服务 fiber 消失时清空引用，避免调用已释放的命名空间。

### 📌 已知噪声

- 本仓库全新 `npm install` 会出现 `npm warn ERESOLVE overriding peer dependency`：`dsh-settings@alpha.5` 声明 `cordis-plugin-loader ~1.0.6-alpha.2`，该范围按 semver **同时接受正式版 `1.0.6`**，而正式版要求正式版 cordis，与宿主使用的 `4.0.5-alpha.2` 不匹配。这些包仅是本仓库 devDependencies 的传递依赖，测试不加载它们（`tests/` 中无引用），发布产物也不含 node_modules —— 纯警告，无功能影响。

---

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
