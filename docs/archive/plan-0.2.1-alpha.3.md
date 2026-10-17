# 开发计划：DSH 0.2.1-alpha.3 适配与接口跟进

- **状态**：**已完成并归档**（2026-10-18 移入 `docs/archive/`；收尾版本 v0.1.43）。本文是历史记录，**不代表现状**——现行文档索引见 `docs/README.md`。
- **日期**：2026-10-15
- **需求依据**：`docs/archive/requirements-0.2.1-alpha.3.md`（R 编号在该文档定义）
- **任务清单**：`docs/archive/tasks-0.2.1-alpha.3.md`
- **前序计划**：`docs/plan.md`（v0.1.x 建仓至 M6，已完成）

## 1. 总体判断

本轮**没有业务代码改动**。全部 13 项需求落在三类载体上：

| 载体 | 需求 | 说明 |
|---|---|---|
| 依赖声明（`package.json`） | R-A1 ~ R-A5 | 阻塞项，两行改动即可解 |
| 测试基础设施（`tests/`、`vitest.config.ts`） | R-B1 ~ R-B2 | CI 健康度 |
| 配置与元数据（profile、`src/go-limits.ts`） | R-B3 ~ R-B4、R-C4 | 正确性/可读性 |
| 常量与端点（`src/catalog/constants.ts`） | R-C1 | 预防性迁移 |
| 文档 | R-C5 | 归档结论 |

**风险等级：低。** 依据：代码层 0 条破坏性变更（typecheck/build 稳定 exit 0）；`cordis`/`schemastery` 的 alpha.1→alpha.2 源码零 diff。

## 2. 阶段划分

### M1 — 依赖对齐与安装解阻塞（R-A1 ~ R-A4）

**为什么合并为一个阶段**：R-A1/A2/A4 必须同时生效才能让 `npm install` 成功；单独改任一项仍会 ERESOLVE。R-A3 是 runtime dep，一并处理。

**步骤**：
1. 备份 `package.json` 与 `package-lock.json`（记录 SHA256）。
2. 改 `package.json`：`devDependencies` 中 20 个 `@deepseek-ai/*` → `0.2.1-alpha.3`（`cordis` → `4.0.5-alpha.2`）；`dependencies.schemastery` → `~3.18.5-alpha.2`；`peerDependencies.cordis` 补 `|| 4.0.5-alpha.2`。
3. **删除 `node_modules` 与 `package-lock.json`**，全新 `npm install`（陈旧 lock 的增量解析跨不过 peer 约束）。
4. 跑三关并保存原始日志。

**完成判据**：`npm install` 退出 0，且 `npm run typecheck`、`npm run build`、`npm test` 三者退出 0。

**回滚**：还原备份的两个文件 + `npm ci`。

### M2 — 测试稳定性加固（R-B1、R-B2）

**关键约束**：R-B1 的根因假设**尚未坐实**（见需求文档 §5 B 组诚实标注）。因此本阶段强制「先复现、后修复」：若选择改造 harness 而非加 retry，**必须先稳定复现失败**，否则不得声称修复。

**候选方案（按推荐度）**：

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **B1-a（推荐）** | 统一 harness：`tests/mock-gateway.ts` 改用 `vi.stubGlobal('fetch', ...)`，与 `tests/setup.ts:5` 的 `vi.unstubAllGlobals()` 语义配对 | 治本，消除真因 | 需确认无其他直接赋值点 |
| B1-b | `vitest.config.ts` 加 `retry: 1` | 最小改动 | **掩盖问题**，且不解决 B2 |
| B1-c | `vitest.config.ts` 加 `fileParallelism: false` | 确定性 | 拖慢 CI，且牺牲并行收益 |

**R-B2 独立于 B1**：mock 掉 `https://models.dev/api.json`。这同时会**削弱 B1 的偶发性**（网络抖动本就是一个放大因素），因此建议**先做 B2 再评估 B1 是否仍复现**。

**完成判据**：连续 **20 次** `npm test` 全部 `exit 0`；断网/屏蔽 `models.dev` 下仍全绿；日志留档。

### M3 — 配置与标注清理（R-B3、R-B4）

**R-B3**：用户 profile 位于**仓库外**（`C:\Users\z9n5\.dsh\profiles\web\cordis.patch.yml`）。按 `docs/plan.md` §2a 的开发边界，**仓库外写入需先获批准**。因此本项拆为：
- 仓库内：不改（该 profile 不属于仓库）。
- 交付形式：给出精确的改动建议与原因，由用户决定是否执行，或授权后执行。

**R-B4**：`src/go-limits.ts:71` 的 `space-bunny-free` 标注。需先判定意图——若该表是「Go 端点限额」，则应删除该条；若意图是「已知但本端点不提供的模型」，则应加显式标记。**属代码改动，需测试覆盖。**

**完成判据**：R-B4 有对应测试；R-B3 有书面建议且经用户确认。

### M4 — 端点迁移与文档对齐（R-A5、R-C1 ~ R-C5）

**R-A5 + R-C1 一起做**（都涉及声明/常量）。R-C1 改 `src/catalog/constants.ts:10` 的 `DEFAULT_BASE_URL`。

**迁移前必须确认**：`zen/go/v1` 与 `inference/go/v1` 的**行为一致性**。已验证：`/models` 返回同一批 37 个模型；`/usage` 均返回 401（需凭证）。**迁移后需用真实凭证各跑一次 `/usage`，确认响应结构一致**——这是唯一未被完全验证的点。

**是否需要新 ADR**：建议为 R-C1 补 **ADR-0006「端点口径迁移到 inference」**，记录：迁移理由（上游文档口径）、等价性证据（实测）、以及 `zen` 若废弃时的处置。同时 R-C5 的免费层结论建议固化为 ADR 或本计划附录，避免未来重复调研。

**R-C2 ~ R-C4 为可选**，需用户明确是否需要，否则不做（避免范围蔓延）。

**完成判据**：迁移后三关全绿 + 真实凭证下 `/models` 与 `/usage` 均正常；ADR-0006 落盘。

## 3. 依赖顺序

```
M1（解阻塞）
  └─> M2（测试健康，需可安装的环境）
        └─> M3（清理，需绿色测试基线）
              └─> M4（迁移，需可回归的基线）
```

**串行理由**：M1 之前无法安装依赖；M2 之前无法信任测试信号；M3/M4 都需绿色基线做回归判定。**不建议并行**——四项都写 `package.json`/`tests/`/`src/`，且有递进的验收依赖。

## 4. 验证策略

沿用 `docs/plan.md` §6 的三层，并按本轮特点补充：

| 层 | 内容 | 本轮新增 |
|---|---|---|
| 契约层 | 本地 mock 网关断言请求头、目录四级判定、用量解析 | **强制**：不得发真实请求（R-B2 即为修复此违规） |
| 安装冒烟 | 打 tarball → 装进隔离 profile → 启动断言路由注册 | 在 alpha.3 运行时下执行 |
| 真实层 | 最小请求确认 200 + 抓包见 `x-opencode-session` | M4 后各跑一次 `/usage` |
| **稳定性层（新）** | — | `npm test` 连跑 20 次；断网条件下全绿 |

## 5. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| 全新 install 引入其他包的版本漂移（非 `@deepseek-ai` 范围） | 中 | install 后 diff `package-lock.json`，确认变更范围仅限预期包 |
| R-B1 用 `retry` 掩盖真因，问题在真实运行时复现 | **高** | 强制「先复现后修复」；优先 B1-a 治本方案 |
| R-B2 mock 掉 `models.dev` 后丢失真实元数据的回归覆盖 | 中 | 保留一份**录制样本**作为 fixture，而非纯手写桩 |
| `zen` 在迁移前被上游废弃 | 低 | 已实测两者等价；迁移本身即为缓解 |
| M4 迁移后 `/usage` 响应结构变化 | 低 | 迁移前用真实凭证比对两域名的 `/usage` 响应 |
| 仓库外写入（profile）超出开发边界 | 中 | 按 §2a 先申请批准；默认只交付建议 |
| 误把「免费模型可接入」当作待办而反复调研 | 中 | 已固化为已否决需求（需求文档 §7）+ 计划补 ADR |

## 6. 决策一览

| 决策 | 结论 | 依据 |
|---|---|---|
| 是否需要改业务代码 | **否** | 代码层 0 破坏性变更 |
| 依赖升级范围 | `cordis` + `schemastery` + 19 个 `dsh-*` | 需求 R-A1~A4 |
| 端点迁移时机 | 本轮做，但定为预防性 | `zen`/`inference` 实测等价 |
| 免费层接入 | **不做**，且不做试错探测 | 需求文档 §7 |
| 测试修复策略 | 优先治本（B1-a），先做 B2 | 根因未坐实 |
| 是否新增 ADR | 是，ADR-0006（端点迁移） | 跨版本决策需留痕 |
| 执行方式 | 串行 M1→M2→M3→M4 | 有递进验收依赖 |

## 7. 交付物

1. 更新的 `package.json` / `package-lock.json`（M1）。
2. 测试基础设施改动 + 20 次连跑日志（M2）。
3. `src/go-limits.ts` 修正 + 测试；profile 改动建议书（M3）。
4. `src/catalog/constants.ts` 迁移 + `docs/adr/0006-*.md` + 真实凭证验证记录（M4）。
5. 版本号：建议 **v0.1.22**（R-A3 影响最终用户，且端点默认值变化，属对外可见变更）。

## 8. 范围外

- 不改 DSH 核心（`D:\git\deepseek-harness`）。
- 不改 OpenCode 上游（`D:\git\opencode`）。
- 不处理 `D:\git\opencode` 中现有的本地未提交修改。
- 不做 R-C2 ~ R-C4，除非用户明确追加。
