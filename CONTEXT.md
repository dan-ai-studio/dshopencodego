# DSH × OpenCode Go 插件

本上下文描述"让 DeepSeek Harness 正常使用 OpenCode Go"这一件事里的专有名词。它只定义语言，不含实现决策。

## Language

**OpenCode Go（Go）**：
OpenCode 推出的每月 $10 订阅制托管推理服务，独立于按量付费的 OpenCode Zen 目录，端点在 `https://opencode.ai/zen/go/v1`。
_Avoid_: opencode 订阅、Go 套餐、zen go

**OpenCode Zen（Zen）**：
OpenCode 的按量付费模型网关（`https://opencode.ai/zen`），与 Go 共用品牌但目录、计费与端点不同。
_Avoid_: 用"opencode"泛指两者

**路由（route）**：
DSH LLM 缝里标识一个 provider 的字符串键，如 `opencode-go`；同一路由在同一 profile 内只能由一个适配器提供。
_Avoid_: 通道、provider 名、模型前缀

**适配器（adapter）**：
实现 DSH LLM 缝、把 Harness 的消息与流词汇翻译成某个路由线协议的组件；本插件为 `opencode-go` 路由提供自己的适配器。
_Avoid_: driver、provider 实现、client

**线协议（wire protocol）**：
Go 网关在同一 baseURL 下同时提供的三种请求形态：`openai-completions`（`/v1/chat/completions`）、`openai-responses`（`/v1/responses`）、`anthropic-messages`（`/v1/messages`）。每个模型只走其中一种。
_Avoid_: API 类型、协议格式、接口风格

**目录（catalog）**：
一次会话/一次设置页读取所看到的"可用模型 + 每个模型的调用方式"的合并结果，由网关公布、在线元数据与内置知识共同决定。
_Avoid_: 模型列表、模型清单

**能力元数据（model metadata）**：
描述单个模型如何被调用的字段：线协议、上下文窗口、最大输出、输入模态、推理能力与档位、单价。
_Avoid_: 模型参数、配置、模型属性

**配置缺失（unconfigured model）**：
网关已公布该模型 ID，但当前无法确定其线协议或能力元数据，因而不能安全调用；与"模型不存在"是两回事。
_Avoid_: 未知模型、失效模型、不可用模型

**会话头（session header）**：
`x-opencode-session`。Go 自 2026-09-05 起要求每个推理请求携带稳定的每会话标识，缺失即 `400 MissingSessionID`。
_Avoid_: session id、会话标识头、亲和头

**会话标识（session id）**：
DSH 为一段对话铸造的稳定 ID（形如 `session-<uuid>`），跨轮次、恢复、压缩与重试不变；本插件把它作为会话头的值。
_Avoid_: 对话 ID、UUID、请求 ID

**用量窗口（usage window）**：
Go 的 `/usage` 端点返回的三个账号级额度百分比：`rolling`（5 小时）、`weekly`、`monthly`，各带重置时间与限流状态。
_Avoid_: 配额、额度、余额

**归属头（attribution）**：
Harness 在所有 provider 请求上发送的产品身份（`user-agent`），Go 用它区分客户端。
_Avoid_: 标识头、UA、指纹
