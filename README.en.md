# @dan-ai-studio/dshopencodego

Makes [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) work with an
[OpenCode Go](https://opencode.ai/docs/go/) subscription: the model list comes from the gateway
itself, and every inference request carries the `x-opencode-session` header the gateway requires.

[中文](README.md)

## Why it exists

Two gaps stop a stock Harness from using OpenCode Go, and neither is a configuration problem:

1. **The model list is a build-time snapshot.** DSH's `llm-pi-ai` serves pi-ai's generated catalog,
   so a model the gateway added this morning is invisible until pi-ai ships a release.
2. **No session header.** Since 2026-09-05 the gateway answers `400 MissingSessionID` without a
   stable per-conversation `x-opencode-session`; `llm-pi-ai` can only send static profile headers.

This plugin owns the `opencode-go` route and closes both.

## Install

```sh
dsh plugin --profile web add https://github.com/dan-ai-studio/dshopencodego/releases/download/v<version>/dan-ai-studio-dshopencodego-<version>.tgz
```

From a checkout:

```sh
npm ci && npm run build && npm pack
dsh plugin --profile web add ./dan-ai-studio-dshopencodego-0.1.0.tgz
```

> One profile can have only one adapter on the `opencode-go` route. Uninstall the previous plugin
> (`@dan-ai-studio/dsh-opencode-go`) or clear that route in `llm-pi-ai` first; otherwise the mount
> reports an explicit route-ownership diagnostic and registers nothing.

## Configure

```yaml
- id: dshopencodego
  name: '@dan-ai-studio/dshopencodego'
  config:
    enabled: true
    apiKeyEnv: OPENCODE_GO_API_KEY
    baseURL: https://opencode.ai/zen/go/v1
    refreshMinutes: 60
    modelVisibility:
      glm-5: true
    modelProtocols:
      some-new-model: openai-responses
```

The key resolves through the Harness credential store under `OPENCODE_GO_API_KEY`, or from the
process environment.

## How a model's protocol is decided

First hit wins: the installed pi-ai catalog entry (protocol plus wire quirks), then models.dev's
per-model `provider.npm`, then a family rule (`grok*`/`gpt*`/`muse-*` → Responses, everything else →
Chat Completions), then an explicit `modelProtocols` override. The gateway listing answers only
*which* models exist, never *how* to call them.

## Usage

- **Quota windows** from `GET /usage`: 5 hours, week, month, with reset times and rate-limit state.
  A failed refresh keeps the previous reading and marks it stale; a changed account drops it.
- **Actual spend** in the conversation: calls and tokens (input/output/cached read) since this
  Harness started, from the usage each provider call reports. The gateway publishes no per-model
  token data, so the label says exactly what the number is.

## Compatibility

- DSH `0.1.7-alpha.1` through the `0.1.7` series (`engines.dsh`).
- `@earendil-works/pi-ai@0.87.1`, carried as this plugin's own copy.

## Verify

```sh
npm test && npm run typecheck && npm run build
```

## License

MIT
