# Changelog

本文件记录 `@dan-ai-studio/dshopencodego` 插件的所有重要变更。

## [0.1.48] - 2026-10-20

本版把「厂商文档在哪」从**写死的一个地址**改成**发现出来的一组地址**。上一版修好了当下这一次挪动，但硬编码路径本身就是 provider 没承诺过的承诺——它已经挪过一次，就还会再挪。

### ✨ 改进 (Improvements)

- **文档路径改为自动发现**（`src/catalog/go-doc-discovery.ts`）。当所有已知路径都读不到时，插件会去问 provider **自己的仓库**「`go.mdx` 在哪」（GitHub 的 tree 列表接口，匿名调用），再从找到的位置读取。发现到的地址会**记住**，所以下一个进程不必再问。
  - 触发时机是**懒触发**：已知路径可用时，一次请求都不会多发。列表接口是匿名限流的（60 次/小时），所以它只在别无选择时才被调用。
  - 识别规则放宽到「文件名以 `go` 开头、后缀 `.mdx`、且位于文档目录中」——provider 若把文件改名（`go-v2.mdx`），仍能认出那是同一份文档；而包源码树里的 `go.ts`、翻译副本不会误认。
  - 实测：硬编码路径全部 404 的情况下，发现 → 读取整条链路 **1.2 秒**完成，端点表 28 个模型照常拿到。
- **已发现的路径会落盘**（`~/.dsh/cache/@dan-ai-studio/dshopencodego/go-doc-paths.json`）。落盘的是**一组「曾经存在过的路径」**，不是「当前路径」——这个区别是要紧的：缓存若只存一个当前路径，那么 provider **再次**挪动文件的那一刻，缓存恰好会递上一个失效路径；而一组候选只会多花一次失败请求。
  - 缓存目录优先取 DSH 自己的 home 解析器（`ctx.dshHomePath`），否则按 DSH 的规则退到 `$DSH_HOME` / `~/.dsh`。写不进去也不影响功能，只是下次要重新发现。
- **失败原因不再只报第一阶段**（`src/catalog/go-doc.ts`）。此前「已知路径失败 + 发现失败」只把前者的原因写进错误信息，发现阶段的结果被吞掉；现在每一阶段的理由都在，包括「provider 仓库没有指名任何文档」和「仓库指名的正是刚试过的那个路径」。

### 🐞 修正 (Fixes)

- **重复请求被去掉**：发现到的路径若映射回已知列表里那两个镜像（provider 并没有挪文件，只是网络抖了一下），不再原样再读一遍。

### 🧪 测试

- **新增 `tests/go-doc-discovery.spec.ts`**：覆盖路径挑选、镜像构造、仓库列表解析、缓存的读写与损坏容错，以及三条端到端路径——已知路径失效后经发现读回、记住后不再询问 provider、两者皆败时报出理由。
- 发现环节**可注入**（`fetchGoDocument` 的 `discover` 选项），因此套件仍然完全离线。
- 套件为 **46 个测试文件 / 343 个用例**。

### 📝 备注

- 协议判定的四级阶梯未变，**顺序也未变**。本版只解决「怎么找到那张表」，不解决「表里的协议怎么判」。
- 为什么仍要保留厂商文档：文档给的是**完整端点路径**（`/chat/completions` 与 `/responses` 的区别）；models.dev 的 `provider.api` 只到 base URL（`/openai/v1`），区分不了这两者；网关的 `/models` 则完全不带协议信息。因此文档仍是「精确协议」的唯一来源，值得为它做自动发现。

---

## [0.1.47] - 2026-10-20

本版修掉一个**已经在悄悄生效的退化**：厂商文档的地址被上游挪走后，协议表整份消失，所有内置目录没有收录的模型退化成「协议为推断」——而界面不会说任何话。

### 🐞 修正 (Fixes)

- **Go 文档地址失效**（`src/catalog/go-doc.ts`）。上游把 `go.mdx` 从 `packages/web/src/content/docs/` 移到了 `services/www/src/docs/content/console/`，旧地址的两个镜像（GitHub raw、jsDelivr）**都返回 404**。这直接抽走了「厂商自己声明的每个模型走哪个协议」这张表——协议判定的第二级证据，也是比 models.dev 的 SDK 提示更权威的那一级。
- **一张表缺失不再废掉另一张表**（`src/catalog/go-doc.ts`）。此前一份文档必须同时带有额度表和端点表才算「读到了」；而上游重构页面时**只保留了端点表**（额度数字已不在该页），于是即便换上新地址，整份文档仍会被判为失败、协议表照样拿不到。额度本来就另有出处——`go-limits.ts` 里那份冻结种子，其注释写明它就是为「文档地址搬走的那一天」准备的。
- **协议不再停在「在线推断」**（`src/catalog/index.ts`）。`withDocumentedProtocol()` 的判断里写着「`inferred` 或 `online` 都该让位给厂商文档」，但它**只被 `inferred` 分支调用**——`online` 分支是死代码。现在有在线元数据的模型同样会接受厂商端点表的覆盖，协议来源由「在线推断」变为「厂商文档」。
- **wire 层不再丢弃 `document`**（`src/catalog/contract.ts`）。`parseModel()` 的白名单漏了 `document` 这一级，于是**最权威的协议来源在跨进程时被扔掉**，客户端看到的是「未知」而非「有据」。此前这一级根本不会产生，所以漏掉也没人发现。
- **未知模型 id 不再反复重拉整份元数据**（`src/catalog/index.ts`）。`forModel()` 对目录里没有的 id 会强制重新验证一次——这正是「新模型刚上架、不重启也能用」的机制。但宿主**每次列模型、每次开会话**都会解析一次模型，于是一个永远解析不出来的 id（打错的、已下线的、会话里的陈旧条目）会让每一次解析都重下 **5.86 MB** 的 models.dev 文档。现在同一个 id 有 **5 分钟冷却**，代价从「每次都付」变成「付一次」。

### ✨ 改进 (Improvements)

- **降级不再是静默的**（`src/catalog/index.ts`、`src/catalog/reading.ts`、`src/catalog/contract.ts`、`src/client/Section.tsx`）。文档或 models.dev 拉取失败时，界面现在会明说「目录已降级：模型元数据（models.dev）不可用 —— <原因>」。此前这类失败只写进日志，而**桌面版没有日志出口**：界面显示「刷新成功」，实际协议已退化成推断、思考级别（来自 models.dev 的 `reasoning_options`）整块消失，用户无从判断。
- **空额度表回落到冻结种子**（`src/catalog/index.ts`）。文档读到了但没有额度表时，不再把「空表」当成「厂商说所有模型都没有额度」——那样页面上额度会整块消失；现在按设计回落种子，并在页面上标注额度来自内置快照。

### 🧪 测试

- **新增 `tests/go-doc-url.spec.ts`**：断言厂商文档的每个地址都返回 200，且**真能用本插件的解析器读出端点表**。此前套件里的文档用例全部注入本地文档，因此解析器只能对着「一份仍然存在的文档」证明自己——上游挪走地址时没有任何东西会红，而插件在真实环境里静默退化。这是只读 GET，不花钱、不计费。
- 补齐协议降级、跨 wire 保留 `document`、降级原因透传、未知 id 冷却等用例。
- 套件为 **45 个测试文件 / 333 个用例**。

### 📝 备注

- 协议判定的四级阶梯（内置目录 → 厂商文档 → models.dev → 家族规则）本次全部重新生效，且顺序未变：**厂商文档仍然压过 models.dev**。核对结果：models.dev 的 SDK 提示与厂商端点表在 37 个模型上**零冲突**，其中 18 个模型 models.dev 没有给 SDK 提示、只能靠 provider 级默认值推测，而它们的实际协议恰好都是 Chat Completions——推测没错，但从此有据可依。
- 本版**没有**改动协议的最终取值，只改「这个取值出自哪一级证据」。对同一个模型，改动前显示「协议为推断」，改动后显示为来自厂商文档。

---

## [0.1.46] - 2026-10-20

本版修正文档里一处**已经失效两个月的上游断言**，并给这类漂移补上门禁。

### 📖 文档

- **README 的「为什么需要它」不再声称原生 DSH 缺会话头**。原文写的是「`llm-pi-ai` 只发静态 profile headers，无法按会话取值」——这句在 pi-ai 实现 `x-opencode-session` 注入之后（2026-09-09，commit `561a2e06`）就不成立了，而内置的 `llm-pi-ai` 会经 `streamSimple` 自动携带该头。留着它，后来的维护者会据此重建已经存在的实现。
- **「为什么需要它」改为可逐条核对的对照表**：实时模型目录、额度窗口、花费估算、逐模型开关四项，各自标明原生 DSH 是否提供。散文式的描述只能整段信或整段疑，对照表可以逐行核对、过期了也只改一行。
- 补充说明：本插件**当前仍保留**自己的会话头实现（它为缺失会话 id 的请求提供一次性 UUID 兜底，而上游在缺失时不注入该头），待该兜底进入上游后再收缩。评估过程见 [`docs/scope-review-2026-10.md`](docs/scope-review-2026-10.md)。
- **新增 [`docs/scope-review-2026-10.md`](docs/scope-review-2026-10.md)**：插件存在必要性评估与职责收缩建议（**状态：未执行**，不描述当前行为）。本版已按本机实装版本（harness `0.2.1-rc.2`、pi-ai `1.3.0`）重算其数字：pi-ai 的 `opencode-go` 快照为 **29** 个模型（初稿按 1.1.0 写的 31 个），因此「实时目录仍是缺口」比初稿所述**更强**（缺口由 6 个扩大为 8 个）。

### 🧪 测试

- **新增 `tests/upstream-facts.spec.ts`**：守住「README 对上游的断言」与「实装的上游」之间的落差。此前套件守的是 manifest 与散文之间的一致，却**没有任何东西守散文与它所描述的上游之间的一致**——这正是那句失效断言在仓库里躺了两个月的原因，也是 v0.1.44 声明了 `llm-pi-ai` 已占用的 provider 键的同类盲区。断言读的是装在 `node_modules` 里的上游实现，因此上游一变就是一次红灯，而不是一段过期的散文。
- **修复一处负载敏感的时序脆弱**（`tests/adapter-stream-teardown.spec.ts`）：该用例此前把「ramp-up」与「stall」共用一个 5 秒期限，在全量并发 + v8 插桩下，握手耗时会吃掉整个预算，stall 被误报成 hang（早先还表现为「watchdog 在首个 delta 之前就触发」）。现在两个阶段各自计时：ramp-up 有独立的宽松上限，stall 从**收到首个 chunk** 起算一个 idle 窗口加余量。用例的判据不变——仍要求 stall 在部分输出之后发生、且以 `TIMEOUT` 失败而非挂起。
- 套件为 **44 个测试文件 / 326 个用例**。

### 📝 备注

- 上一版修复 idle 超时时留意到的一个语义细节：watchdog 的**第一次**计时窗口覆盖的是「SSE 握手 + 首个 delta」，而不是「两个 delta 之间的间隔」。默认的 `streamIdleTimeoutMs`（300 秒）远大于握手时间，不受影响；只有把它调到秒级以下才可能误杀。本版未改变该语义。

---

## [0.1.45] - 2026-10-18

### 🐞 修正 (Fixes)

- **撤回 configurable-provider 目录条目的注册**（v0.1.44 引入的那部分）。`opencode-go` 这个 provider 键**已经由内置的 `llm-pi-ai` 声明**——它会遍历 pi-ai 的整个内置目录（`llm-pi-ai/src/index.ts:148`），而 DSH 的 provider 目录**按键唯一**，重复声明抛 `DUPLICATE_DIRECTORY`（`llm/src/index.ts:515-518`）。

  **为什么必须撤回**：谁先注册谁赢，而 `llm-pi-ai` 的注册**没有 try/catch**（`llm-pi-ai/src/index.ts:246-261`）。一旦本插件先加载，这个异常会冒泡出它的 `apply`，**连带它服务的所有 provider（`deepseek`、`nvidia` 等）一起失效**。在 v0.1.44 里，因为 `@deepseek-ai/dsh-base` 排在 bundles 列表前面，本插件总是后手，所以只表现为一条没有用途的 error 日志——那是**加载顺序的侥幸，不是设计保证**。

  **代价为零**：Models 页本来就通过 pi-ai 提供 `opencode-go` 的配置入口，本插件再声明一次既冗余，又只增加一条"取决于加载顺序地破坏邻插件"的路径。

  **保留**的是同批做掉的、真正属于本插件的部分：discovery 以 profile 条目 id 作 `settingsNs` 注册（此前用模块名，导致 DSH 从不为它发起 discovery），以及取消信号向文档抓取的透传。

### 🧪 测试

- `tests/runtime-plugin-wiring.spec.ts` 改为**固化"不得注册目录条目"这一决定**（mock 记录任何调用，一旦有人加回来就红），并保留 `settingsNs` 与 signal 的断言。套件仍为 43 个文件 / 316 个用例。

---

## [0.1.44] - 2026-10-18

本版来自一轮四维度独立审计（代码 / 测试 / 交付 / 文档），共 41 项修复与增强。

### ⚠️ 破坏性变更 (Breaking changes)

- **`baseURL` 不再接受非本机的明文 `http://`**：凭证走 `authorization` 头，明文 http 会让 API Key 裸露在链路上。现在只有 `localhost` / `127.0.0.1` / `[::1]` 允许 http（本地 mock 与验证代理不受影响），其余主机**必须 https**，违规在加载或写入配置时立即报错。**若你把 `baseURL` 指向内网 http 网关，请先改为 https，否则升级后插件会被门禁拒绝加载。**
- **`exports["./client"].types` 已移除**：它指向 `./lib/types/client/index.d.ts`，而客户端半边是 `noEmit` 的浏览器 bundle，该文件**从未被生成过**——TypeScript 消费者此前拿到的是坏指针。
- **peer 上界由 `<0.3.0` 收紧为 `<0.3.0-0`**：DSH 的兼容判定含预发布，原范围会把 `0.3.0-rc.1` 判为兼容，从而放行一个从未验证过的主版本。`engines.dsh` 与 17 个 `dsh-*` peer 全部更新。
- **`prepare` 脚本已移除**：`npm ci` 不再隐式构建，请显式 `npm run build`（三个 CI workflow 已显式构建；`prepack` 仍保证发布产物是当次构建）。

### 🐞 修正 (Fixes)

- **流空闲超时会挂死，而不是抛出可重试的 `TIMEOUT`**：`adapter` 在 teardown 里 `await iterator.return()`，而契约明确要求不得等待（被放弃的 demand 会把 return 排在它之后）；同时 `AbortSignal.any` 会用后 abort 的源覆盖 watchdog 的 reason，导致超时被读成普通取消。两处一起修好。
- **CI 缺少 lint 门禁**：`ci.yml` 从未跑过 `npm run lint`，lint 失败要等到手工发布那一步才暴露——而那时 tag 与公开 Release 已经存在。现已加入。
- **验证脚本失败时仍返回退出码 0**：`model-probe.mjs` 的失败分支只打印不置码，"失败"会被误读成通过；`live-check.mjs` 还把模型 id 钉死在一个早已从内置目录消失的条目上，根本跑不起来。两者都改为用退出码表达结果，并补上真实断言。
- **`ctx.llm.registerModelDiscovery` 是死注册**：从不注册 provider 目录条目，而 DSH 只为目录条目发起 discovery；`signal` 也被忽略（上游契约明文要求 honoring）。现已注册目录条目、改用 profile 条目 id 作 `settingsNs`、并透传 `signal`。
- **冷启动首次推理最坏要等 20 秒**：目录构建被文档抓取绑架——两个文档 URL 串行、各 10 秒超时。现改为并行，并把取消信号贯通整个 snapshot/build 路径。
- **`loader/volatile-update` 裸注册**：`syncRoute` 内的注册被释放时会抛错，而 Cordis 的 emit 是 `Array.map`，一个同步抛错会饿死其后的所有 listener。现已包上 try/catch 并记日志。
- **目录失败复用了用量的错误码**（`catalogFailure` 是死代码且码值与 usage 相同，界面会按错误码走错分支）：改为独立的 `dshopencodego/catalog-unavailable` 并真正使用。
- **会话回放状态自己读不回来**：写侧允许的 `stopReason` 集合不是读侧白名单的子集，`pending`/`deferred` 会被写进日志、下一轮降级并丢签名。写侧现收敛到可回放集合。
- **`rc.10` 被判成比 `rc.9` 旧**：更新检查用字典序比较预发布标识符，现按 semver 规则比较（数字按数值、数字小于字母）。
- **发布说明脚本的正则用了 JavaScript 不支持的 `\Z`**：它退化成字面量 `Z`，导致 CHANGELOG 的**最后一段**（通常正是要发布的版本）整体匹配失败、发布被中止。
- **构建脚本依赖调用者的当前目录**：从其他目录执行会删掉该目录下的 `lib/`，并因找不到本地 `tsc` 而失败。现以包根定位。

### ✨ 新增 (Features)

- **估算花费**：用量面板新增按 models.dev 单价 × provider 回传 token 的**估算金额**（不是账单；订阅端点仅供参考，按量端点才有对账意义）。**没有单价的模型如实显示「未定价」并列出模型名，绝不以 0 冒充免费**；单价随每次调用记录，目录刷新不会重算已花掉的 token。
- **推理 token**：provider 报告的思考 token 单独显示。它是 `outputTokens` 的**子集**，因此**不计入总量**，避免同一批 token 被算两次。
- **插件出现在 DSH 的 provider 配置界面**：注册了 provider 目录条目，并声明默认端点；缺凭证时给出可修复的诊断，而不是静默缺席。
- **无效模型开关诊断**：`modelVisibility` 里写了但网关并不提供的模型 id（例如已下线的模型）现在会被一次性警告指出，而不是静默无效。

### 🔒 安全 (Security)

- **验证代理不再把凭证明文落盘**：`recording-proxy.mjs` 记录请求头前会脱敏 `authorization` / `x-api-key` / `cookie`（只保留 scheme 与长度，供比对）；文档标注历史产物可能仍含明文，不要分享或提交。
- **`.gitignore` 覆盖 `.env` / `.env.*`**（此前只靠"仓库里没有该文件"）。

### ⚙️ 发布与工程 (Release & engineering)

- **`release.yml` 门禁对齐 `ci.yml`**：它创建**对外可见**的 Release，此前却只跑 `npm test`（无覆盖率地板、无 lint、无 typecheck）。现为 build → lint → typecheck → test:coverage。
- **npm 发布后有核验**：`publish-npm` 发布后确认 registry 真的 served 该版本（失败非零退出）；另新增只读的 `verify-registry` workflow，每周核对最新 tag 与 registry（历史上 0.1.0–0.1.4 只有 tag、从未上 npm）。
- **workflow 硬化**：补 `permissions`（最小化）、`concurrency`、`timeout-minutes`，并新增 Dependabot 跟踪 `github-actions` 与 `npm`。
- **`lib/types` 不再携带 31 个 `.js` 编译副产物**（−157 KiB，这些文件运行时用不到且会绕开 bundle 走另一条解析路径）。
- **客户端 external 表与 DSH 平台模块表做机械校验**：原先的检查是自证的（被 `external` 命中的说明符永远不会出现在 `unsupported` 一侧），发现不了上游改名。

### 🧪 测试

- **43 个测试文件 / 317 个用例**；覆盖率 statements 81.9% / branches 76.9% / functions 74.8% / lines 85.5%（地板 75/70/70/80）。
- 新增覆盖：流空闲超时与 teardown、验证脚本的退出码契约、运行时装配与目录条目、回放与更新检查、花费与用量观测、`baseURL` 边界、发布说明提取。
- 修正一处**负载敏感的时序脆弱**：`adapter-stream-teardown` 的 stall 窗口原为 100 ms，在全量并发 + v8 插桩下会在收到首批 delta 前就触发 watchdog，导致 `test:coverage` 间歇失败（CI 更慢，几乎必然踩到）。

### 📖 文档

- **README 兼容性章节按源码修正**：真正生效的门禁是 `engines.dsh`（声明了它就**只**用它，peer 范围被整体跳过），原文说反了；同时给出上界为何必须是 `<0.3.0-0` 的解释，以及"如何确认装成功"的正确方法（原先给的 `--dump-config | grep` 对被门禁拒绝的行同样会输出，证明不了加载成功）。
- **`CONTEXT.md`** 端点修正为 `inference/go/v1`（ADR-0006 迁移后名词表未同步）。
- **ADR-0004** 删除代码中从不存在的 `qwen* → anthropic-messages` 家族规则并留修订痕；**ADR-0006** 的快照计数标注为当时值；**新增 ADR-0007** 记录显式传递 peer 的意图。
- **`docs/` 增加索引**，四份阶段性文档归档至 `docs/archive/` 并补状态行，ADR 0001–0005 补齐 Status/Decision/Consequences。
- **README 补配置约束**（`baseURL` 形状、`refreshMinutes` 上限、`modelLimits` 的 `null` 语义、`modelProtocols` 合法值、`retryPolicy`）与用量口径说明；默认开关规则的描述改为与代码一致的"逐模型覆盖 + 未列出仍走 top5"。

---

## [0.1.43] - 2026-10-17

### 🔧 依赖跟进 (Dependency tracking)

- **跟进到 DSH `0.2.1-rc.2`**：21 个 `dsh-*` 开发依赖升到 `0.2.1-rc.2`，`@deepseek-ai/cordis` 升到 **`4.0.5` 正式版**。
- **`cordis` 的 peer 范围补上 `4.0.5`**：此前只有 `4.0.4 || 4.0.5-alpha.1 || 4.0.5-alpha.2`——那时 `4.0.5` 还只有 alpha。DSH `0.2.1-rc.2` 起用的是**正式版** `4.0.5`，不补这一项，插件在 rc 环境下会被 peer 门禁直接拒绝加载。
- **上游契约层零改动**：`llm`、`gateway`、`typert`、`settings`、`client/modules`，以及 vendored 的 `cordis` 源码，在 `0.2.1-alpha.5 → 0.2.1-rc.2` 之间**只改了版本号**（逐个目录 `git diff --stat` 确认）。因此本次**不需要任何代码适配**。
- **全新安装才干净**：增量安装会因旧 `package-lock.json` 与 rc.2 的 peer 组合报 `ERESOLVE`（`dsh-attachment@rc.2` 要求 `dsh-brand@rc.2`，而 lock 里仍是 alpha.5）。删除 `node_modules` 与 lock 后重装：**244 包 / 0 漏洞 / 无 ERESOLVE**——与 T-24、T-26 的既定流程一致。
- **同时兼容两代运行时**：`0.2.0-rc.2`（cordis `4.0.4`）与 `0.2.1-rc.2`（cordis `4.0.5`）都在声明范围内，range 未变（`>=0.2.0-rc.1 <0.3.0`）。桌面端内置的 DSH 是 `0.2.0-rc.2`，本次改动不会把它排除在外。

---

## [0.1.42] - 2026-10-17

### ✨ 改进 (Improvements)

- **「更新说明」按钮现在真的能看到说明**：它原先指向 **npm 包页面**——而 npm 渲染的是 README，**不含更新日志**，所以这个按钮回答不了它唯一该回答的问题："这一版改了什么"。现在指向**该版本的 GitHub Release**（`/releases/tag/v<版本>`，检查尚无版本时退回 releases 索引）。
- **发布流程自动带上更新说明**：`release.yml` 原先用 `gh release --generate-notes`，结果每个 Release 的说明只有一行 compare 链接。现在由新增的 `scripts/release-notes.mjs` **从 `CHANGELOG.md` 提取对应版本段落**作为说明；提取不到就**以非零退出码中止发布**，而不是发布一个空说明。手工创建过的 Release 也会被补上同样的说明。

### 🐞 修正 (Fixes)

- **`update/check.ts` 的模块注释已过时**：它仍写着"registry 不可达就静默隐藏横幅"——那是 v0.1.28 修复前的行为。实际上现在 `UpdateStatus.checked` 会保持 `false`，页面明确报"无法访问 registry"，而不是把它呈现成"已是最新"。

### 🧪 测试

- 新增两条结构性不变量：`REPOSITORY` 常量与 `package.json` 的 `repository` 一致（漂移会让链接 404）；「更新说明」链接必须指向 Release 而非 npm 包页面。

---

## [0.1.41] - 2026-10-17

### ⚡ 工具链 (Tooling)

- **`typescript` 6.0.3 → 7.0.2**：类型检查从 **31.09 秒降到 3.28 秒（约 9.5 倍）**，且对我们的代码**零报错**。
  - **为什么它不影响运行时**：本插件的运行时代码由 **esbuild** 产出，`tsc` 只做两件事——类型检查、生成 `.d.ts`。升级前后 **`lib/index.js` 逐字节相同**（`FBDF08B1…`），这条是本次升级的硬验收指标，不是推断。
  - **对外声明文件**：用两个版本各自生成后逐一比对，**30 个文件完全相同**，仅 1 个差异——`INPUT_MODALITIES` 的字面量引号由双引号变为单引号，类型语义不变。
  - 与 DSH 的版本差异（DSH 仍在 `typescript@^6.0.3`）**不影响运行**，只是工具链版本不同；`peerDependencies` 的门禁从不检查 TS。

### 🐞 修复 (Fixes)

- **Client 产物不可复现**：`lib/client.js` 每次构建都不相同——差异来自 CSS Modules 的类名映射对象，lightningcss（Rust）返回 export map 的顺序在两次运行间会变。类名本身是稳定的（由文件名与局部名哈希而来），变的只是**写入顺序**，但这已足够让产物无法用哈希校验。现按名排序后再写出：**连续三次构建得到同一个哈希**。`lib/index.js` 一直是确定的，未受影响。

---

## [0.1.40] - 2026-10-17

### 🛠️ 工具链 (Tooling)

三项与 DSH 运行时**无关**的升级（它们都不产出运行时产物，见下），因此与宿主版本是否一致不构成约束：

- **接入 `oxlint`（1.88.0）并接进发布流程**：新增 `npm run lint`，并在 `publish-npm.yml` 里置于 `npm ci` 之后、测试之前——静态检查最快能失败，发布不该先花几分钟跑完套件再死在 lint 上。首次运行只报 2 条：一条是真问题（`tests/mock-gateway.ts` 把三元表达式当语句用，已改写为 `if/else`），一条是有意忽略的 catch 参数（按业界惯例配置 `caughtErrorsIgnorePattern: '^_'`，而不是关掉规则）。已验证**有告警时退出码为 1**，因此这道闸门是有效的而非摆设。
- **`vitest` 4.1.12 → 5.0.5（含 `@vitest/coverage-v8`）**：零破坏性变更，33 文件 / 229 用例全过，`test:coverage`（发布流程依赖）退出码 0，覆盖率 80.32 / 73.61 / 73.33 / 84.08 均高于门槛。
- **`jsdom` 29.1.1 → 30.1.3**：jsdom 环境的用例与全量套件均通过。

### 📖 文档 (Documentation)

- **修正 README 里严重过时的测试计数**：正文写着「148 个用例 / 24 个文件」，实际已是 **229 / 33**——漂移了 81 个用例无人察觉。现改为按目录校验的**文件数**，并新增用例把它钉在 `tests/` 目录上（已用临时回退验证：改成 24 会立刻失败）。用例数不再写进正文，因为 `it.each` 的展开让它无法从源码静态数准，写死就一定会再次漂移。
- 开发命令列表补上 `npm run lint`。

### 📌 未升级项（有意保留）

`typescript` 6.0.3 → 7.0.2 **本次不做**：它对 DSH 运行时同样没有影响（运行时代码由 esbuild 产出，`tsc` 只做类型检查与 `.d.ts`），但 **DSH 自身当前也停在 `typescript@^6.0.3`**。保持与宿主工具链同版本，比追求最新更有价值——需要时可以再单独评估。

---

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
