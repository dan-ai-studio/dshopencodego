# 任务列表：DSH 0.2.1-alpha.3 适配与接口跟进

- **状态**：M1–M4 已完成（T-01–T-22 `done`）；后续追加的 T-24、T-25 已完成并在真实页面验证；T-23 `pending`（未批准，需用户明确追加）
- **日期**：2026-10-15
- **需求依据**：`docs/requirements-0.2.1-alpha.3.md`
- **计划依据**：`docs/plan-0.2.1-alpha.3.md`
- **执行原则**：串行 M1 → M2 → M3 → M4；每个任务独立可回滚；**每个任务完成即更新本表状态**。

## 状态图例

`pending` 未开始 · `doing` 进行中 · `blocked` 被阻塞 · `done` 已完成 · `dropped` 取消（需注明理由）

---

## M1 — 依赖对齐与安装解阻塞

| ID | 任务 | 需求 | 依赖 | 写范围 | 验收标准 | 状态 |
|---|---|---|---|---|---|---|
| **T-01** | 备份 `package.json` 与 `package-lock.json` 到 `scratch/m1-backup/`，记录两者 SHA256 | — | — | `scratch/m1-backup/` | 两文件存在；SHA256 记录在案 | done |
| **T-02** | `devDependencies["@deepseek-ai/cordis"]`：`4.0.5-alpha.1` → `4.0.5-alpha.2` | R-A1 | T-01 | `package.json` | 字段值为 `4.0.5-alpha.2` | done |
| **T-03** | `devDependencies` 中其余 19 个 `@deepseek-ai/dsh-*` → `0.2.1-alpha.3` | R-A4 | T-01 | `package.json` | 无字段仍指向 alpha.2 | done |
| **T-04** | `dependencies["@deepseek-ai/schemastery"]`：`~3.18.5-alpha.1` → `~3.18.5-alpha.2` | R-A3 | T-01 | `package.json` | 字段值与 `dsh-settings@alpha.3` 的 peer 一致 | done |
| **T-05** | `peerDependencies["@deepseek-ai/cordis"]` 枚举补 `\|\| 4.0.5-alpha.2` | R-A2 | T-01 | `package.json` | `semver.satisfies('4.0.5-alpha.2', 新范围) === true` | done |
| **T-06** | 删除 `node_modules` 与 `package-lock.json`，全新 `npm install` | R-A1 | T-02..T-05 | `node_modules/`, `package-lock.json` | `npm install` 退出 0；无 ERESOLVE | done |
| **T-07** | 跑三关并保存原始日志到 `scratch/m1-logs/` | R-A4 | T-06 | `scratch/m1-logs/` | `typecheck`/`build`/`test` 均退出 0；日志含退出码 | done |
| **T-08** | diff 新旧 `package-lock.json`，确认变更范围仅限预期包 | 计划 §5 | T-06 | — （只读分析） | 无预期外的包版本漂移；结论写入日志 | done |

**M1 出口判据**：T-07 三关全绿 + T-08 无意外漂移。

---

## M2 — 测试稳定性加固

> **强制约束**：R-B1 根因未坐实。**先做 T-09，据其结果决定 T-11 的方案**；不得在未复现的情况下声称修复。

| ID | 任务 | 需求 | 依赖 | 写范围 | 验收标准 | 状态 |
|---|---|---|---|---|---|---|
| **T-09** | 基线复现：在当前状态下连跑 `npm test` **20 次**，统计失败率与失败签名 | R-B1 | M1 | `scratch/m2-logs/baseline/` | 20 份日志留档；给出失败次数与失败用例名 | done |
| **T-10** | Mock 掉 `https://models.dev/api.json`（改为录制样本 fixture），使单测零网络 | R-B2 | T-09 | `tests/`, `scratch/m2-fixtures/` | 断网/屏蔽该域名下 `npm test` 全绿 | done |
| **T-11** | 消除竞态：优先方案 = 统一 harness（`tests/mock-gateway.ts` 改用 `vi.stubGlobal('fetch', …)`，与 `tests/setup.ts:5` 的 `vi.unstubAllGlobals()` 配对） | R-B1 | T-10 | `tests/`, `vitest.config.ts` | 见 T-12 | done |
| **T-12** | 回归验证：连跑 `npm test` **20 次** 全部 `exit 0` | R-B1 | T-11 | `scratch/m2-logs/after/` | 20/20 退出 0；日志留档 | done |

**决策点（T-09 之后）**：若 T-10 完成后失败**不再复现**，则 T-11 降级为「仅做 harness 语义统一，不引入 retry」，并在日志中说明「偶发由外部网络依赖贡献」。若仍复现，则按计划 §2 M2 的 B1-a → B1-b → B1-c 顺序择一，且**必须在交付说明中标注所选项及其代价**。

**M2 出口判据**：T-12 达到 20/20，且 T-10 使测试零网络依赖。

---

## M3 — 配置与标注清理

| ID | 任务 | 需求 | 依赖 | 写范围 | 验收标准 | 状态 |
|---|---|---|---|---|---|---|
| **T-13** | 判定 `src/go-limits.ts:71` 中 `space-bunny-free: { monthlyUsd: 'unlimited' }` 的意图，并据判定修正（该模型**不在** Go 端点 37 个模型内） | R-B4 | M2 | `src/go-limits.ts`, `tests/` | 限额表不含 Go 端点不存在的模型；有对应测试 | done |
| **T-14** | 产出 profile 改动建议书（**不直接改仓库外文件**）：说明 `C:\Users\z9n5\.dsh\profiles\web\cordis.patch.yml` 中 `modelVisibility.space-bunny-free` 为空转项及原因 | R-B3 | M2 | `scratch/m3-profile-advice.md` | 建议书含：现状、证据（实测 400）、建议改动、回滚方式 | done |

**开发边界提示**：T-14 默认**只交付建议**。若需实际修改 profile，须先获得用户明确批准（依据 `docs/plan.md` §2a）。

**M3 出口判据**：T-13 有测试覆盖；T-14 建议书交付并经用户确认。

---

## M4 — 端点迁移与文档对齐

| ID | 任务 | 需求 | 依赖 | 写范围 | 验收标准 | 状态 |
|---|---|---|---|---|---|---|
| **T-15** | 修正 `engines.dsh` 范围，使其在标准 semver 下覆盖 `0.2.1-alpha.*` | R-A5 | M3 | `package.json` | `semver.satisfies('0.2.1-alpha.3', 新范围) === true`（**不加** `includePrerelease`） | done |
| **T-16** | 迁移前验证：用**真实凭证**分别请求 `https://opencode.ai/zen/go/v1/usage` 与 `https://opencode.ai/inference/go/v1/usage`，比对响应结构 | R-C1 | M3 | `scratch/m4-usage-compare.md` | 两者结构一致（或记录差异）；**这是迁移前唯一未完全验证的点** | done |
| **T-17** | 改 `src/catalog/constants.ts:10` 的 `DEFAULT_BASE_URL` 为 `https://opencode.ai/inference/go/v1` | R-C1 | T-16 | `src/catalog/constants.ts`, `tests/` | 迁移后 `/models` 与 `/usage` 行为与迁移前一致；三关全绿 | done |
| **T-18** | 写 `docs/adr/0006-<slug>.md`：记录端点口径迁移的理由、等价性证据、`zen` 废弃时的处置 | R-C1, R-C5 | T-17 | `docs/adr/0006-endpoint-migration-to-inference.md` | ADR 含 Context / Decision / Consequences / Evidence | done |
| **T-19** | 更新 `docs/plan.md` 或新增衔接说明，指向本轮三份文档 | R-C5 | T-18 | `docs/plan.md` | 新读者可从 `plan.md` 找到本轮文档 | done |
| **T-20** | 版本号提升至 `v0.1.22`，撰写 CHANGELOG 条目（标注 R-A3 与端点默认值属**对外可见变更**） | 计划 §7 | T-17 | `package.json`, `CHANGELOG.md` | 版本一致；变更说明区分「对外可见」与「内部」 | done |

**M4 出口判据**：三关全绿 + T-16 真实凭证验证通过 + ADR-0006 落盘 + 版本号已提升。

---

## 可选任务（需用户明确追加，否则不执行）

| ID | 任务 | 需求 | 说明 | 状态 |
|---|---|---|---|---|
| **T-21** | 支持 Console 主端点 `https://opencode.ai/inference/v1`（86 模型） | R-C2 | 导出 `CONSOLE_BASE_URL`，86 模型离线解析与三协议路由全覆盖，单测见 `tests/console-endpoint.spec.ts` | done |
| **T-22** | 补齐会话亲和头 `x-session-affinity`（取值同 `x-opencode-session`） | R-C3 | 在 `src/session-header.ts` 中统一派发，单测见 `tests/session-header.spec.ts` | done |
| **T-23** | 在设置页/限额表标注 Go 端点免费模型的「额度耗尽后仍可用」语义 | R-C4 | **前提已变（2026-10-17 核对官方文档）**：原定 3 个模型中，`step-5-preview-free` 已改名为 `step-5-preview` **且不再免费**（$60 月度额度，4x 限时）；`longcat-2.5-preview-free` 仍免费；`cat-jam-free` 未列入文档的当前模型表但挂在 pi-ai 内置目录中；文档新增免费模型 `beam-free`（Unlimited，限部分地区）。与 pi-ai 1.3.0 的目录出入说明上游数据源也有滞后。**需重新确认标注范围后再执行** | pending（前提已变，待重新批准） |
| **T-28** | 清理审计（v0.1.39） | 本次审计 | 修正 `build.mjs` 头部已失效的描述（仍称"所有包 external"）；把 21 个仅本模块使用的符号从 `export` 收回（它们不在 `src/index.ts` 的公开导出里，导出只会让实现细节看起来像契约）。扫描同时确认：无死代码（`noUnusedLocals`/`noUnusedParameters` 已开启）、无未使用依赖、删除代码无残留引用、`scratch/` 已被 gitignore | done（v0.1.39） |
| **T-24** | 依赖跟进到 DSH `0.2.1-alpha.4` | 计划 §7 | 21 个 `dsh-*` devDeps 升至 alpha.4（cordis 维持 `4.0.5-alpha.2`）；按 T-01 约定备份并记录 SHA256；全新安装 258 包 / 0 漏洞 / 无 ERESOLVE；三关全绿。peer 范围与 `engines.dsh` 本已覆盖，无需改动。证据：`scratch/t24-backup/` | done（v0.1.31） |
| **T-25** | 设置页一键更新（检查新版本 → 卸载旧版 → 安装新版） | 用户追加 | Remote `opencodeGoUpdate`（`readUpdate`/`refreshUpdate`）+ 设置页横幅与二次确认；实际安装交由宿主 `pluginManager`，插件不改写自身文件 | done（v0.1.23–v0.1.33） |
| **T-26** | 依赖跟进到 DSH `0.2.1-alpha.5` | 计划 §7 | 21 个 `dsh-*` devDeps 升至 alpha.5；先核对上游：`llm`/`typert`/`settings`/`client` 契约层源码零变更，**无需适配**；全新安装 258 包 / 0 漏洞；三关全绿。证据：`scratch/t26-backup/` | done（v0.1.34） |
| **T-27** | README 兼容性表与实际声明保持一致 | 本次审计 | 修正四处漂移（pi-ai 差三个大版本、cordis peer 缺 alpha 分支、engines.dsh 缺 0.2.1-alpha 段、schemastery 版本）；新增 `tests/readme-consistency.spec.ts` 逐条断言**对应表格行**（中英各一份），并以临时回退验证其确实能抓到漂移 | done（v0.1.34） |

### T-25 的验证记录

一键更新在真实页面上**已跑通**（2026-10-16，用户确认「立即更新功能正常」，0.1.30 → 0.1.31 由该按钮完成）。
该功能共修复七类缺陷，每一类都由新增测试锁定：

1. **调用参数个数（v0.1.25）**：`readUpdate(force)` 传了位置参数，而描述符声明零参数，网关按 arity 拒收 → 改为与目录一致的 `readUpdate`/`refreshUpdate` 双零参方法。
2. **失败静默（v0.1.26）**：检查失败时 phase 回落 `idle`，而 `idle` 不渲染任何内容，导致任何失败都不可见也无法重试 → 改为可见的 `failed` 态并给重试。
3. **Cordis 依赖声明（v0.1.27）**：读取未在 `inject` 声明的服务不是返回 `undefined` 而是抛 `cannot get property "…" without inject`；`remote.opencodeGoUpdate` 与 `remote.pluginManager` 都曾遗漏（后者由新增的静态一致性测试当场抓出）。
4. **查询失败冒充成功（v0.1.28）**：registry 不可达与"确认无更新"读数相同，页面会显示"已是最新"这句谎话 → `UpdateStatus.checked` 区分两者。
5. **先卸载再失败（v0.1.29）**：预检把联合类型的 `refused` 结果当作通过，会径直卸载运行中的版本，安装失败即让用户失去插件 → `refused`/`bundle: false` 都在动手前中止。
6. **目录冷启动不重验证（v0.1.30）**：`forModel` 用"快照是否仍等于 await 前的缓存"判断是否重验证，冷目录下恒为假，首次构建缺失的模型直接以 `UNKNOWN_MODEL` 失败 → 改为按 id 是否可服务判断（该缺陷同时是 `adapter.spec.ts` 长期间歇失败的根因）。
7. **插件管理器取值为 undefined（v0.1.33）**：v0.1.29 为避免"组合无插件管理器时整个设置页消失"，改用一次性 `ctx.get('remote.pluginManager')`。但 Cordis 的 `get` 默认 strict——提供该服务的 fiber 尚未 `ACTIVE` 时返回 `undefined`，而插件 `apply` 期间正是这种状态；取到的 `undefined` 被固化，页面便永久报「当前组合没有插件管理器」。这解释了同一实现有时能更新、有时不能（0.1.31 成功、0.1.32 失败）的时序现象。现改为响应式 `inject` + 持有对象（`PluginManagerHolder`）：服务晚到也能自愈，真缺失时仍如实降级。

无功能影响的已知噪声：启动 DSH 时可能看到 `Accessing non-existent property 'Allow' of module exports inside circular dependency`，来源为 `pi-ai → partial-json` 的循环依赖，非本项目代码（详见 v0.1.31 起 CHANGELOG 与本次排查结论）。

---

## 明确不做

| 项 | 理由 |
|---|---|
| 接入 OpenCode 免费层（`Bearer public`） | 官方明确访问控制，`FreeTierError`：「only be used from within OpenCode」。完整论证见需求文档 §7。**不安排任何试错性探测** |
| 伪造 `x-opencode-client` / User-Agent 绕过门禁 | 同上；可能危及已付费的 Go 账号 |
| 写入 `D:\git\deepseek-harness` | 只读参考 |
| 写入 `D:\git\opencode` | 只读参考；其现有本地未提交修改不属本任务范围 |

---

## 执行注意

1. **每完成一个任务，立即更新本表状态**，并保留验收证据的路径。
2. **M1 的 T-06 会清空 `node_modules`**：若同时有其他工作依赖该目录，先协调。
3. **不得把「未跑」记为「通过」**；失败必须记录原始报错与退出码。
4. **T-14 涉及仓库外文件**，默认只交付建议。
5. 全部完成后，`scratch/` 下的调查产物（`api-audit/`、`build-verify/`）可作为历史证据保留，是否清理由用户决定。
