# @dan-ai-studio/dshopencodego

让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 正常使用 [OpenCode Go](https://opencode.ai/docs/zh-cn/go/) 订阅：模型列表直接来自网关，且每个推理请求都携带网关要求的 `x-opencode-session`。

[English](README.en.md)

## 为什么需要它

原生 DSH 接 OpenCode Go 有两个缺口，都不是配置能补的：

1. **模型列表是构建期快照**。DSH 的 `llm-pi-ai` 用 pi-ai 打包时生成的目录；网关新增模型后，要么等 pi-ai 发版，要么手工声明。
2. **没有会话头**。Go 自 2026-09-05 起要求每个请求带稳定的 `x-opencode-session`，缺失即 `400 MissingSessionID`；`llm-pi-ai` 只发静态 profile headers，无法按会话取值。

本插件为 `opencode-go` 路由提供自己的适配器，同时解决这两点。

## 安装

从 GitHub Release 安装（`dsh plugin add` 支持 tarball 地址）：

```sh
dsh plugin --profile web add https://github.com/dan-ai-studio/dshopencodego/releases/download/v<版本>/dan-ai-studio-dshopencodego-<版本>.tgz
```

本地构建安装：

```sh
npm ci
npm run build
npm pack
dsh plugin --profile web add ./dan-ai-studio-dshopencodego-0.1.0.tgz
```

> 同一个 profile 里 `opencode-go` 路由只能由一个适配器提供。安装前请先卸载旧插件（`@dan-ai-studio/dsh-opencode-go`）或清空 `llm-pi-ai` 中该路由的配置，否则插件会记录一条明确的占用诊断，路由不会注册。

## 配置

配置写在 profile 的 `cordis.patch.yml`：

```yaml
- id: dshopencodego
  name: '@dan-ai-studio/dshopencodego'
  config:
    enabled: true                            # false 仅撤下路由，插件保持挂载
    apiKeyEnv: OPENCODE_GO_API_KEY            # 默认值
    baseURL: https://opencode.ai/zen/go/v1    # 默认值
    refreshMinutes: 60                        # 目录缓存时长
    modelVisibility:                          # 逐模型开关（弃用模型默认关闭）
      glm-5: true
    modelLimits:                              # 逐模型容量覆盖
      kimi-k3:
        contextWindow: 262144
    modelProtocols:                           # 最后兜底：逐模型协议覆盖
      some-new-model: openai-responses
```

API Key 通过 Harness 凭证库提供（引用名 `OPENCODE_GO_API_KEY`），也可以直接 `export OPENCODE_GO_API_KEY=...`。

## 模型是怎么判定的

一个模型"怎么调"由四级证据决定，先命中先赢：

1. **内置 pi-ai 目录的精确条目**——给出协议与线怪癖（如 DeepSeek 的 `thinkingFormat`）。
2. **models.dev 的每模型 `provider.npm`**——`@ai-sdk/openai` → Responses，`@ai-sdk/anthropic` → Messages，缺省 → Chat Completions。
3. **家族规则**——`grok*`/`gpt*`/`muse-*` → Responses，其余 → Chat Completions。
4. **`modelProtocols` 覆盖**——永远最高优先。

网关的 `/v1/models` 只回答"有哪些模型"，不回答"怎么调"。被推断出来的模型会在设置页标注，判错时用 `modelProtocols` 覆盖即可。

## 用量

- **额度窗口**：`GET /usage` 返回 5 小时 / 本周 / 本月三个百分比，含重置时间与限流状态；失败时保留上次读数并标注陈旧，账号或端点变化时不保留。
- **实际消耗**：会话内按钮显示本进程自启动以来的调用次数与 token（输入/输出/缓存读），数据来自 provider 每次调用回传的 usage。网关不公布分模型 token，因此这里如实标注口径，不伪造分模型配额。

## 兼容性

- DSH：`0.1.7-alpha.1` 至 `0.1.7` 系列（`package.json` 的 `engines.dsh` 声明，运行时不匹配会明确报错）。
- 依赖 `@earendil-works/pi-ai@0.87.1`（插件自带的独立副本，不受 DSH 自身 pin 影响）。

## 验证

```sh
npm test          # 契约测试：本地真 HTTP 网关断言会话头、流式、工具调用、用量
npm run typecheck # host 与 client 两半
npm run build     # 产出 lib/index.js 与 lib/client.js
```

## 许可证

MIT
