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

> **Using the Desktop app?** It does not install through the CLI — install, upgrade, and remove plugins from its in-app Plugins page. See "Desktop (Electron app)" below.

### Option 1: npm (recommended)

```sh
dsh plugin --profile web add @dan-ai-studio/dshopencodego@<version>
```

Confirm the composition picked it up:

```sh
dsh --profile web --dump-config | grep dshopencodego
```

### Option 2: GitHub Release

```sh
dsh plugin --profile web add https://github.com/dan-ai-studio/dshopencodego/releases/download/v<version>/dan-ai-studio-dshopencodego-<version>.tgz
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

### Desktop (Electron app)

The DSH Desktop app is an Electron shell around the complete dsh Web application, and this plugin fits it the same way: the host half is a standard bundle patch, and the client half declares the `web` platform — the Desktop renders exactly that Web client, so the settings section and the in-conversation usage button come from the same client packages. The Desktop keeps its **own profile** at `$DSH_HOME/profiles/desktop`, independent of `profiles/web`: credentials, model visibility, and plugin settings must be configured again there.

Installation **must** go through the in-app UI — do not use the `dsh plugin` commands above:

1. Open the Desktop app → **Settings → Plugins**;
2. Enter `@dan-ai-studio/dshopencodego` as the install spec (or pin a version, e.g. `@dan-ai-studio/dshopencodego@0.1.11`), and confirm;
3. **Restart the app** when prompted, then enter the API key on the settings page (reference name `OPENCODE_GO_API_KEY`).

Why: Electron owns the Desktop profile, and **the CLI cannot boot or mutate it** (Desktop README: *The CLI cannot boot or mutate this profile.*). Plugin management runs through the app's authenticated HTTP APIs and Desktop's bundled pnpm, so no `pnpm` on `PATH` is required. Upgrades and removals happen on the Plugins page too.

The version constraint matches the CLI: the DSH bundled with the Desktop app must stay on the `0.1.7` line (`>=0.1.7-alpha.1 <0.1.8`, see "Compatibility"). If the plugin ever breaks startup, the Desktop's native recovery dialog can **disable third-party plugins, back up `cordis.patch.yml`, and restart** in one action — it will not lock the app out.

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
    retryPolicy:                              # optional: this route's retry policy, executed by dsh-llm-retry
      mode: normal
      maxRetries: 2
      backoff:
        initialDelayMs: 500
```

The API key comes from the Harness credential store (reference name `OPENCODE_GO_API_KEY`), or from `export OPENCODE_GO_API_KEY=...`.

**Output cap**: a caller's own `maxTokens` travels as given, still clamped by a `modelLimits` ceiling. When a caller names none, the host materializes the route's ceiling — the catalog's output capacity, or whatever `modelLimits` overrode it with.

**Tool declarations**: every request carries the complete current tool list. The session-folded history the host offers (`toolHistory`) is deliberately **not** projected: projecting it requires the route to declare a `toolUpdate` mode, and models.dev states no such mode for this gateway's models (only that tools are callable). Claiming one would silently change what the model sees.

**Retries**: `retryPolicy` is optional — omit it and the host's own default applies. When set, the optional `dsh-llm-retry` plugin executes it, and a malformed policy fails where it is written rather than at the first failure.

## How a model is resolved

Four evidence levels decide how a model is called, first hit wins:

1. **The installed pi-ai catalog entry** — protocol plus wire quirks (DeepSeek's `thinkingFormat`, for example).
2. **models.dev's per-model `provider.npm`** — `@ai-sdk/openai` → Responses, `@ai-sdk/anthropic` → Messages, absent → Chat Completions.
3. **Family rule** — `grok*`/`gpt*`/`muse-*` → Responses, everything else → Chat Completions.
4. **`modelProtocols` override** — always wins.

The gateway's `/v1/models` answers only *which* models exist, never *how* to call them. Inferred decisions are labelled in the settings page; override them with `modelProtocols`.

## The model list in the settings page

The "OpenCode Go" section shows the live gateway catalog (the count follows the gateway) with, per model:

- **context / max input / max output**, **release date**, **price per 1M tokens** (from models.dev), and **Go allowance**;
- **Go allowance** is fetched at runtime from the provider's own documentation — the "usage limits / estimated requests" tables, whose source is a markdown file in the provider's repository (GitHub first, jsDelivr second) — and refreshes with the catalog every 60 minutes. A failed fetch keeps the last successful parse; a process that never succeeded uses the **built-in snapshot** and the page says so, with the transcription date (`src/go-limits.ts`, frozen, not maintained by hand). A moved or restructured document counts as a failed fetch, never as an emptied column;
- **Input modalities**: a separate line lists the input modes models.dev declares (text / image / audio / video / PDF). These are the **model's own metadata**, not what the Harness can forward — the Harness sends text and images natively; audio/video/PDF travel as attachments and tool reads. The line is absent when the document declares none.
- filtering (by name/id, enabled-only, show-deprecated — **deprecated hidden by default**), sorting (newest first, monthly requests, input price, context, name, enabled first); the list is the only view, one model per row.

**Default switches**: with no explicit `modelVisibility` entries at all, the **top five models by published monthly request estimate** are enabled (deprecated, unconfigurable, and training-"contributor" models never qualify). The first explicit entry switches the whole list to explicit values. The Host picker and the settings page compute this from one rule, so they never disagree.

## Usage

- **Quota windows**: `GET /usage` reports 5-hour / weekly / monthly percentages with reset times and rate-limit flags; a failed read keeps the last reading and marks it stale, and an account or endpoint change invalidates it.
- **Actual spend**: the in-conversation button reports calls and tokens (input/output/cache-read) this process spent since it started, from the usage the provider returns on each call. The gateway publishes no per-model tokens, so the numbers are labelled for what they are instead of faking a per-model quota.

## Compatibility

**Supported**: DSH `0.1.7` releases (including `0.1.7-alpha.1`, `0.1.7-rc.*`, and the final release). Every `@deepseek-ai/dsh-*` peer dependency declares `>=0.1.7-alpha.1 <0.1.8`.

**The mechanism (not a hard pin)**: before mounting a plugin, DSH reads its `package.json` `peerDependencies` and semver-checks each against the **running DSH version** (prereleases participate):

- all satisfied → the plugin loads;
- any mismatch → **that plugin row is disabled with a printed reason** (`Plugin … is incompatible with dsh …`), leaving other plugins untouched;
- to take the risk anyway, grant an **exact-version exemption**: `dsh plugin --profile <profile> allow-version <pkg>@<version> --dsh-version <exact> --accept-risk` (applies only to that package and that exact runtime version); `dsh plugin --profile <profile> version-exemptions` lists what a profile holds.

The `engines.dsh` field is informational for readers and package managers; **DSH's compatibility gate reads only `peerDependencies`**. `@deepseek-ai/cordis` is declared separately as `4.0.2 || 4.0.3 || 4.0.4`.

**0.1.8+ or older releases**: the plugin is refused. If the seam is compatible, widen the peer range in your own build (never in DSH core), or wait for a plugin release.

### Version-binding notes

| Binding layer | Declared | Enforced by |
| --- | --- | --- |
| `peerDependencies` (17 `@deepseek-ai/dsh-*` packages) | all `>=0.1.7-alpha.1 <0.1.8` | **DSH's gate, at plugin load time** |
| `@deepseek-ai/cordis` | `4.0.2 \|\| 4.0.3 \|\| 4.0.4` | the same gate |
| `engines.dsh` | `>=0.1.7-alpha.1 <0.1.8` | informational only; DSH never reads it |
| `engines.node` | `^22.19.0 \|\| >=24.0.0` | the package manager |
| bundled `@earendil-works/pi-ai` | pinned to exactly `0.87.1` | an independent coupling: a change in pi-ai's request construction changes this plugin's wire behaviour |
| bundled `@deepseek-ai/schemastery` | `^3.18.3` | ordinary semver |

Things to keep in mind when maintaining this:

- **Required versus optional peers**: six of the eighteen are marked `optional` (`dsh-api-remotes`, `dsh-client-locale`, `dsh-client-store`, `dsh-client-ui-model-selection`, `dsh-client-ui-settings`, `dsh-client-ui-slots`). The twelve that actually block loading are `cordis`, `dsh-attachment`, `dsh-brand`, `dsh-client-ui-conversation`, `dsh-client-ui-renderer`, `dsh-credentials`, `dsh-fs`, `dsh-launch-environment`, `dsh-llm`, `dsh-timeout`, `dsh-typert-protocol`, and `dsh-typert-registry`. `dsh-llm` is the heaviest coupling — more than twenty imports across the source.
- **Declared range ≠ verified range**: `0.1.7-alpha.1` and `alpha.2` fall inside the declaration but were never verified here. What was verified is `0.1.7-rc.1` (the dev-dependency baseline) and `0.1.7-rc.2` (daily use).
- **The upper bound is a tracking line**: `<0.1.8` means that the moment DSH ships `0.1.8`, this plugin must ship a new release in the same window or every user loses the plugin. After changing a range, `npm test` is the verification (local mock gateway, no network, no tokens) — ranges follow what the interfaces declare, and are never "measured" with live probes.
- **Peer coverage is now guarded both ways**: `dsh-typert-registry`, `dsh-client-ui-conversation`, and `dsh-client-ui-renderer` were imported by the source but absent from `peerDependencies`, invisible to the gate; they are declared now, and `tests/peer-coverage.spec.ts` asserts both directions — anything the source imports must be declared, and anything declared but unreached must be removed (`dsh-settings` went that way: the settings form is actually provided by `dsh-client-ui-settings`).
- **Exemptions are per profile**: only a profile that ran `dsh plugin allow-version` has one, and no record means the plugin must stay inside the declared range. `dsh plugin version-exemptions` lists a profile's exemptions.

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
| npm publish fails with `ENEEDAUTH` | OIDC did not match: check the Trusted Publisher's **workflow filename** (must be exactly `publish-npm.yml`, case-sensitive) and the organization/repository fields; run on GitHub-hosted runners with `id-token: write`. A `repository.url` that does not match the GitHub repository is rejected as well. |

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
3. **npm (trusted publishing / OIDC, no token)**: `.github/workflows/publish-npm.yml` is manual-only and authenticates through GitHub Actions' OIDC — this repository **has no `NPM_TOKEN` and needs none**. Run it with:

   ```sh
   gh workflow run publish-npm --repo dan-ai-studio/dshopencodego -f tag=v<version>
   ```

   It verifies tag-versus-version, refuses to overwrite a version that already exists on npm, and the publish carries an automatically generated **provenance** attestation. It relies on the package's **Trusted Publisher** connection on npm (fields are fixed once created; to change one, delete and recreate it):

   | Field | Value |
   |---|---|
   | Publisher | `GitHub Actions` |
   | Organization or user | `dan-ai-studio` |
   | Repository | `dshopencodego` |
   | Workflow filename | `publish-npm.yml` (exact, case-sensitive) |
   | Environment name | (empty) |
   | Allowed actions | `Allow npm publish` checked (unchecked means staged-only: a maintainer must approve each publish with 2FA) |

   Additionally: OIDC publishing needs **npm CLI ≥ 11.5.1 / Node ≥ 22.14** (the workflow uses Node 24), and `package.json`'s `repository.url` must match the GitHub repository. Once OIDC works, switch the package's Settings → **Publishing access** to "Require two-factor authentication and disallow tokens" and revoke any tokens you no longer need.

## License

MIT
