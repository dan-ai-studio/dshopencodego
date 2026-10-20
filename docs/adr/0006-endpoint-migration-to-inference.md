# 0006. 默认网关端点从 /zen/go/v1 迁移至 /inference/go/v1

## Status（状态）

Accepted（已执行，落地版本 `v0.1.22`）。

## Context（背景）

- OpenCode 早期对外发布 OpenCode Go 订阅服务时，采用 `https://opencode.ai/zen/go/v1` 作为推理和目录端点。
- 在上游官方文档演进过程中（例如 `https://opencode.ai/v2/docs/console/go/`），所有官方示例与端点表格已全面统一切换为 `https://opencode.ai/inference/go/v1` 口径。
- 插件 `@dan-ai-studio/dshopencodego` 此前的默认配置常量 `DEFAULT_BASE_URL` 仍保留为历史的 `zen` 端点。为了保持与官方最新标准演进一致，防止未来官方收拢或废弃 `zen` 路由引发被动故障，需要进行预防性平滑迁移。

## Decision（决策）

1. **更新默认基准 URL**：将 `src/catalog/constants.ts` 中的 `DEFAULT_BASE_URL` 默认值由 `https://opencode.ai/zen/go/v1` 改为 `https://opencode.ai/inference/go/v1`。
2. **保持配置向后兼容**：保留用户配置级 `config.baseURL` 覆盖机制。如果用户在私有网络、反向代理或需回退旧端点，仍然可以通过显式指定配置项自定义端点。
3. **固化免费层调研结论**：确认 OpenCode 免费层（`Bearer public`）受严格的客户端身份风控，严禁伪造客户端绕过；插件仅支持合规的付费 Go 凭证鉴权。

## Evidence（实测证据）

在实施迁移前，通过真实网络请求与抓包对两套端点进行了双向验证。原始对比记录 `scratch/m4-usage-compare.md` 是**本机一次性验证产物：它落在被 `.gitignore` 忽略的 `scratch/` 下，不随仓库分发，克隆者无法核对**；可复现的结论摘要见 `docs/archive/requirements-0.2.1-alpha.3.md` §5 与下面两条：

1. **模型目录接口（`/models`）逐条完全一致**：
   - `GET https://opencode.ai/zen/go/v1/models` 返回 200 OK，包含 37 个模型；
   - `GET https://opencode.ai/inference/go/v1/models` 同样返回 200 OK，包含同一批 37 个模型，各模型属性完全一致。
2. **用量配额接口（`/usage`）逐字段完全等价**：
   - 携带真实 Go API Key 发起测试，两个端点均返回 `200 OK` 且响应头均为 `application/json`；
   - 响应 JSON 结构均为 `{ usage: { rolling, weekly, monthly } }`，子字段均为 `{ percent, resetsAt, status }`，模式定义一致性校验为 `true`，数据精度与重置周期完全相同。
   - 这两条是**当时**的抓包结论；重新验证需要真实凭证与真实网络请求，仓库里的契约测试（本地 mock 网关）不覆盖线上等价性。
3. **全量测试套件通过**：
   - 迁移当时（`v0.1.22`）运行 `npm run typecheck && npm run build && npm test`，**28 个测试文件、181 个测试用例**全部通过，零破坏性影响。
   - 这两个数字是**迁移当时的快照，不是现状**：此后套件持续增长，现行数字由 `tests/readme-consistency.spec.ts` 对着 `tests/` 目录校验（2026-10-20 实测：45 个测试文件、333 个用例；用例数用 `npx vitest list` 复算）。

## Consequences（后果与影响）

- **对外可见变更**：用户在缺省 `baseURL` 配置下，所有针对 Go 目录的探活、用量查询以及推理调用将透明转向 `https://opencode.ai/inference/go/v1`。
- **废弃应对策略**：
  - 如果未来官方正式停止 `zen` 路由解析，已迁移至本版本（`v0.1.22`）的用户不受任何影响；
  - 仍在使用旧版插件的用户若因 `zen` 废弃产生错误，可通过在 profile 中显式设置 `baseURL: https://opencode.ai/inference/go/v1` 立即恢复服务，或升级至 `v0.1.22` 及以上版本。
- **术语同步**：`CONTEXT.md` 的名词表在这一轮迁移后仍是旧口径（Go 写 `zen/go/v1`、Zen 写 `https://opencode.ai/zen`），已于 2026-10-18 按本文结论改回 `inference` 口径。
