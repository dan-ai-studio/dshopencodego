# @dan-ai-studio/dshopencodego

Makes [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) work properly with an [OpenCode Go](https://opencode.ai/docs/go/) subscription: the model list comes straight from the gateway, and every inference request carries the `x-opencode-session` header the gateway requires.

[中文](README.md)

## Why it exists

A stock DSH route to OpenCode Go has two gaps that no configuration can close:

1. **The model list is a build-time snapshot.** DSH's `llm-pi-ai` uses the catalog pi-ai shipped with; when the gateway adds a model, you either wait for a pi-ai release or declare it by hand.
2. **No session header.** Since 2026-09-05 Go requires a stable `x-opencode-session` on every request and answers `400 MissingSessionID` without it; `llm-pi-ai` sends only static profile headers, which cannot vary per conversation.

This plugin serves the `opencode-go` route with its own adapter and closes both gaps.

## Install

Prerequisites: a DSH `0.1.7` release (see "Compatibility"); Node `^22.19.0 || >=24.0.0`; `dsh` and `pnpm` on PATH.

> **One owner per route**: a profile can have exactly one adapter for `opencode-go`. Remove the previous plugin (`dsh plugin --profile <p> remove @dan-ai-studio/dsh-opencode-go`) or clear any `opencode-go` provider in `llm-pi-ai` first. Otherwise the plugin logs an explicit ownership diagnostic and does not register the route — everything else keeps working.

### Option 1: GitHub Release (recommended)

```sh
dsh plugin --profile web add https://github.com/dan-ai-studio/dshopencodego/releases/download/v<version>/dan-ai-studio-dshopencodego-<version>.tgz
```

Confirm the composition picked it up:

```sh
dsh --profile web --dump-config | grep dshopencodego
```

### Option 2: npm (prepared, not enabled yet)

The publish workflow exists but is inert until the npm scope and `NPM_TOKEN` exist (see "Releasing"). Once enabled:

```sh
dsh plugin --profile web add @dan-ai-studio/dshopencodego@<version>
```

### Option 3: build locally

```sh
npm ci
npm run build
npm pack
dsh plugin --profile web add ./dan-ai-studio-dshopencodego-<version>.tgz
```

> Install tarballs by **local path**. A remote tarball URL against a profile that already has a cache hits pnpm's `ERR_PNPM_MISSING_TARBALL_INTEGRITY` (see "Troubleshooting").

### Upgrade and remove

```sh
dsh plugin --profile web add <new tarball or package>          # upgrade
dsh plugin --profile web remove @dan-ai-studio/dshopencodego    # remove
```

> pnpm silently reuses a **same-named local tarball** (`added 0`). Rename the file when reinstalling a fresh local build.

## Configuration

Configuration lives in the profile's `cordis.patch.yml`:

```yaml
- id: dshopencodego
  name: '@dan-ai-studio/dshopencodego'
  config:
    enabled: true                            # false withdraws the route only
    apiKeyEnv: OPENCODE_GO_API_KEY            # default
    baseURL: https://opencode.ai/zen/go/v1    # default
    refreshMinutes: 60                        # live catalog TTL
    modelVisibility:                          # per-model switches (deprecated default off)
      glm-5: true
    modelLimits:                              # per-model capacity overrides
      kimi-k3:
        contextWindow: 262144
    modelProtocols:                           # last resort: per-model protocol override
      some-new-model: openai-responses
```

The API key comes from the Harness credential store (reference name `OPENCODE_GO_API_KEY`), or from `export OPENCODE_GO_API_KEY=...`.

## How a model is resolved

Four evidence levels decide how a model is called, first hit wins:

1. **The installed pi-ai catalog entry** — protocol plus wire quirks (DeepSeek's `thinkingFormat`, for example).
2. **models.dev's per-model `provider.npm`** — `@ai-sdk/openai` → Responses, `@ai-sdk/anthropic` → Messages, absent → Chat Completions.
3. **Family rule** — `grok*`/`gpt*`/`muse-*` → Responses, everything else → Chat Completions.
4. **`modelProtocols` override** — always wins.

The gateway's `/v1/models` answers only *which* models exist, never *how* to call them. Inferred decisions are labelled in the settings page; override them with `modelProtocols`.

## The model list in the settings page

The "OpenCode Go" section shows the live gateway catalog (42+ models) with, per model:

- **context / max input / max output**, **release date**, **price per 1M tokens** (from models.dev), and **Go allowance**;
- **Go allowance** comes from OpenCode's own documentation (the "usage limits / estimated requests" tables) — **no API exposes it**. It is a transcribed table (source URL and date in the `src/go-limits.ts` header); pricing or promotion changes require updating it and shipping a release;
- filtering (by name/id, enabled-only, show-deprecated — **deprecated hidden by default**), sorting (newest first, monthly requests, input price, context, name, enabled first), and a list/table view switch.

**Default switches**: with no explicit `modelVisibility` entries at all, the **top five models by published monthly request estimate** are enabled (deprecated, unconfigurable, and training-"contributor" models never qualify). The first explicit entry switches the whole list to explicit values. The Host picker and the settings page compute this from one rule, so they never disagree.

## Usage

- **Quota windows**: `GET /usage` reports 5-hour / weekly / monthly percentages with reset times and rate-limit flags; a failed read keeps the last reading and marks it stale, and an account or endpoint change invalidates it.
- **Actual spend**: the in-conversation button reports calls and tokens (input/output/cache-read) this process spent since it started, from the usage the provider returns on each call. The gateway publishes no per-model tokens, so the numbers are labelled for what they are instead of faking a per-model quota.

## Compatibility

**Supported**: DSH `0.1.7` releases (including `0.1.7-alpha.1`, `0.1.7-rc.*`, and the final release). Every `@deepseek-ai/dsh-*` peer dependency declares `>=0.1.7-alpha.1 <0.1.8`.

**The mechanism (not a hard pin)**: before mounting a plugin, DSH reads its `package.json` `peerDependencies` and semver-checks each against the **running DSH version** (prereleases participate):

- all satisfied → the plugin loads;
- any mismatch → **that plugin row is disabled with a printed reason** (`Plugin … is incompatible with dsh …`), leaving other plugins untouched;
- to take the risk anyway, grant an **exact-version exemption**: `dsh plugin allow-version <pkg>@<version> --dsh-version <exact> --accept-risk` (applies only to that package and that exact runtime version).

The `engines.dsh` field is informational for readers and package managers; **DSH's compatibility gate reads only `peerDependencies`**. `@deepseek-ai/cordis` is declared separately as `4.0.2 || 4.0.3 || 4.0.4`.

**0.1.8+ or older releases**: the plugin is refused. If the seam is compatible, widen the peer range in your own build (never in DSH core), or wait for a plugin release.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Log says `another adapter already owns it`; the plugin's models are missing | The `opencode-go` route is owned by the previous plugin or by an `llm-pi-ai` provider entry. Remove the owner or clear its config, then restart. |
| Settings page shows "Not configured" while requests still work | Pre-v0.1.4 builds had this defect (credential results were not unwrapped from their envelope). Upgrade. |
| Install fails with `ERR_PNPM_IGNORED_BUILDS` | A fresh profile's `pnpm-workspace.yaml` carries placeholder `allowBuilds` text; set `@google/genai` and `protobufjs` to `false` (neither needs to run scripts) and reinstall. |
| Remote tarball install fails with `ERR_PNPM_MISSING_TARBALL_INTEGRITY` | pnpm wants an integrity entry for a cached profile. Download the tarball and install by **local path**. |
| A reinstalled local tarball behaves like the old build | pnpm reuses a same-named local tarball. Rename the file and install again. |
| "The settings write was rejected" | Usually a concurrent writer (another window or process) holding the same profile. The plugin retries once automatically; if it still fails the view has reloaded — click again. |
| The usage button shows "unavailable" | An endpoint or credential change invalidated the previous reading. Fix the configuration and press Retry. It never shows `0` in place of a missing reading. |

## Development

```sh
npm ci
npm run typecheck   # both halves: host and client
npm test            # contract tests against a real local HTTP mock gateway
npm run build       # emits lib/index.js and lib/client.js
```

148 tests across 24 files cover configuration validation, the protocol ladder, gateway and online metadata, the catalog projection, the adapter on the wire (all three protocols), Remote contracts and services, session-header invariants, usage windows and the meter, the client controller and usage pill, and both halves' mounting and registration.

## Releasing (maintainers)

1. **Version**: align `package.json`'s `version` with the tag you are about to push (`v<version>`); CI checks the asset name against the tag.
2. **GitHub Release**: commit and push `main`, then push the tag. `release.yml` runs the tests, `npm pack`s, and uploads the tarball as the release asset.
3. **npm (prepared, not enabled)**: `.github/workflows/publish-npm.yml` is manual-only and needs publish rights for the `@dan-ai-studio` scope plus the `NPM_TOKEN` repository secret. It verifies tag-versus-version, refuses to overwrite an existing version, and publishes with `--provenance`. The enablement steps live in the file header.

## License

MIT
