# Changelog

本文件记录 `@dan-ai-studio/dshopencodego` 插件的所有重要变更。

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
