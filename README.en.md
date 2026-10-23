# @dan-ai-studio/dshopencodego

Makes [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) work properly with an [OpenCode Go](https://opencode.ai/docs/go/) subscription: the model list comes straight from the gateway, and every inference request carries the `x-opencode-session` header the gateway requires.

[中文](README.md)

## Why it exists

A stock DSH route to OpenCode Go already works (`llm-pi-ai` ships the provider). What this plugin adds is what that route does **not** do:

| Capability | Stock DSH | This plugin |
| --- | --- | --- |
| **Live model catalog** | A build-time snapshot: the fixed table pi-ai ships with, so a new gateway model waits for a pi-ai release | Reads the gateway catalog live, with multi-level fallback and TTL caching |
| **Quota windows** (5-hour / weekly / monthly) | None | ✅ |
| **Estimated spend** | None | ✅ |
| **Per-model switches** `modelVisibility` | None | ✅ |

This plugin serves the `opencode-go` route with its own adapter and adds the usage and settings surfaces.

> **On the session header**: Go requires a stable `x-opencode-session` on every request and answers `400 MissingSessionID` without it. That was one of this plugin's original reasons to exist, but pi-ai implemented the injection on 2026-09-09 (`561a2e06`) and `llm-pi-ai` carries it automatically, so a stock DSH route does not miss the header either. This plugin still keeps its own implementation — it falls back to a one-off UUID when a session id is missing — until that fallback lands upstream; the review is in [`docs/scope-review-2026-10.md`](docs/scope-review-2026-10.md).

## Install

Prerequisites: a DSH `0.2.0` release (`0.2.0-rc.1` or later; see "Compatibility"); Node `^22.19.0 || >=24.0.0`; `dsh` and `pnpm` on PATH.

> **One owner per route**: a profile can have exactly one adapter for `opencode-go`. Remove the previous plugin (`dsh plugin --profile <p> remove @dan-ai-studio/dsh-opencode-go`) or clear any `opencode-go` provider in `llm-pi-ai` first. Otherwise the plugin logs an explicit ownership diagnostic and does not register the route — everything else keeps working.

> **Using the Desktop app?** It does not install through the CLI — install, upgrade, and remove plugins from its in-app Plugins page. See "Desktop (Electron app)" below.

### Option 1: npm (recommended)

```sh
dsh plugin --profile web add @dan-ai-studio/dshopencodego@<version>
```

**After installing, confirm it actually loaded** — `--dump-config` cannot prove that:

1. The startup output should carry the plugin's own registration line, `dshopencodego: route "opencode-go" registered as OpenCode Go` (with `enabled: false` it is `dshopencodego: disabled by configuration; …`). No line means no load — when the compatibility gate refuses the plugin, the same output stream carries `Plugin … is incompatible with dsh …`.
2. A profile without HMR reports `restart-required` (`restartReason: no-hmr`) after the install: the plugin takes effect only after you **restart DSH**.
3. Where the logs are: a failed startup writes the full diagnostic to `$DSH_HOME/logs/startup-<timestamp>-<uuid>.log` and prints that path; a failed `dsh plugin` run prints `dsh: plugin command failed; diagnostics: <path>` (a file under the profile's `.plugin-manager/logs/operation-*/pnpm.log`).
4. Whether the session header really goes out: `node tools/verify/live-check.mjs --check-only` is a **zero-cost** local pre-flight that prints the `x-opencode-session` and `x-session-affinity` this run would carry; dropping `--check-only` and adding `--allow-live` sends **one** minimal request instead (it costs money; rules in `tools/verify/README.md`), after which the script asserts and prints `OK x-opencode-session: <session id>`.

> `dsh --profile web --dump-config | grep dshopencodego` is **not** load evidence: a plugin row the gate denied still appears in the dump (`packages/boot/app-boot/README.md`). It only proves the row was written into the composition.

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

The version constraint matches the CLI: the DSH bundled with the Desktop app must stay inside the declared and verified band (`>=0.2.0-rc.1 <0.3.0`, see "Compatibility"). If the plugin ever breaks startup, the Desktop's native recovery dialog can **disable third-party plugins, back up `cordis.patch.yml`, and restart** in one action — it will not lock the app out.

## Configuration

Configuration lives in the profile's `cordis.patch.yml`:

```yaml
- id: dshopencodego
  name: '@dan-ai-studio/dshopencodego'
  config:
    enabled: true                            # false withdraws the route only
    apiKeyEnv: OPENCODE_GO_API_KEY            # default
    baseURL: https://opencode.ai/inference/go/v1    # default (OpenCode Go endpoint)
                                              # http(s) only, and no query or fragment; writing ?x=1 is refused when the profile is saved
                                              # or https://opencode.ai/inference/v1 (Console main endpoint, pay-as-you-go/free models)
    refreshMinutes: 60                        # live catalog TTL, 1 ~ 10080 (7 days)
    streamIdleTimeoutMs: 300000               # stream idle timeout: longest silence between events (ms)
    keepAliveTimeoutMs: 600000                # connection kept idle between requests (ms, 1 ~ 1800000)
                                               # the timer restarts on every answer, so a connection in
                                               # frequent use is never dropped; a long pause in a
                                               # conversation costs one handshake (about 200ms)
    imageBudgetPreset: dsh                    # image budget preset: dsh / dshopencodego / pi-ai (default dsh, the host's own values)
    modelVisibility:                          # per-model switches; unlisted models follow the default rule (see "The model list in the settings page")
      glm-5: true
    modelLimits:                              # per-model capacity overrides
      kimi-k3:
        contextWindow: 262144
        maxTokens: 32768                      # optional: this model's output cap
      some-legacy-model: null                 # a whole-entry null: both fields explicitly fall back to the catalog values
    modelProtocols:                           # last resort: per-model protocol override
      some-new-model: openai-responses        # the only legal values are anthropic-messages / openai-completions / openai-responses
    pinnedAddresses:                           # fixed IP: host -> address (only the gateway host counts)
      opencode.ai: 104.18.32.47              # IPv4 or IPv6; an invalid or absent address uses the system DNS
    requestLogEnabled: true                  # request-log master switch, default on: off reads byte-for-byte as without the log
    requestLogDebug: false                   # debug detail: pool events and the request user agent; session ids are always whole
    requestLogMaxEntries: 200                # most entries to keep, 50 to 500; oldest are dropped first
    retryPolicy:                              # optional: this route's retry policy, executed by dsh-llm-retry
      mode: normal                            # or always (retry every failure; maxRetries is ignored)
      maxRetries: 2                           # default 5
      retryableCodes: [RATE_LIMIT, TIMEOUT]   # optional: retry only these codes (defaults RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT / EMPTY_RESPONSE)
      backoff:
        initialDelayMs: 500                   # default 500
        maxDelayMs: 10000                     # default 10000, ceiling 2147483647
        jitterRatio: 0.1                      # default 0.1, range 0 ~ 1
```

**Validated on save**: those constraints are checked when the profile is **written**, not at the first request — `baseURL` must be http(s) with no query or fragment; `refreshMinutes` ranges from 1 to 10080; `keepAliveTimeoutMs` ranges from 1 to 1800000; `requestLogMaxEntries` ranges from 50 to 500; every `modelLimits` field may be `null`, meaning "select the catalog value explicitly" (`modelLimits.<id>: null` sends both fields back); `modelProtocols` accepts only those three values, and a wrong one makes that model appear as *configuration missing* (switch off, not selectable) rather than falling back to a guess; `retryPolicy` is a union (`normal` reads `maxRetries`/`retryableCodes`/`backoff`, `always` reads only `backoff`) and unknown keys are rejected.

The API key comes from the Harness credential store (reference name `OPENCODE_GO_API_KEY`), or from `export OPENCODE_GO_API_KEY=...`.

**Stream timeout**: `streamIdleTimeoutMs` bounds the **longest silence between two stream events**, not the total request duration — a long-thinking model that keeps producing events is never cut off. Default 5 minutes; the ceiling is `2147483647` (about 24.8 days). Exceeding it raises `TIMEOUT`, which is retryable.

**Connection kept**: `keepAliveTimeoutMs` decides **how long a connection to the gateway is held between two requests**. The timer **restarts on every answer**, so a connection in frequent use is never dropped; it bounds only the silence between two requests. Default 10 minutes.

- The reason is practical: once a connection is dropped, the next request pays a TCP and a TLS handshake again — **about 200 milliseconds** from here to the gateway — and that cost lands on the **first token of the next turn**. A pause in a conversation (reading the answer, thinking, typing) usually runs 5 to 30 seconds, which is longer than the HTTP client's own 4-second default, so **almost every turn paid for a handshake it did not need**.
- This only affects deployments that **pin an address** (`pinnedAddresses`): with no pin the request goes through the system's own fetch, and this plugin adds nothing to it.
- The settings page shows and accepts the value in **seconds** (a number of milliseconds is not readable at a glance) and stores it in milliseconds. Range: 1 to 1800000 milliseconds.
- Once a connection has been idle that long, the pool **reclaims it** on its own — no separate mechanism is needed. The actual release comes a couple of seconds later than the setting, which is the client's own small margin beyond the deadline the server states. When the plugin is unloaded, the pool is **closed with it**: the pool belongs to the plugin and should not be left behind on the machine.

**Request log**: per-request records, on by default; turning them off returns the request path to exactly as without the log. The settings page's "Request log" group holds the master switch, the debug switch (pool events and the request user agent, default off), and the retention count (default 200).

- **Two entries, one page**:
  - **A sidebar icon → a full page in the main column**: every request across sessions. The log is a process-wide thing, so the sidebar is where it belongs — a fixed, always-visible spot, and the same pattern the Harness's own plugin manager uses.
  - **A "Request log" View inside the conversation**: this session's requests, in place — answering "why was that turn slow" without leaving the chat.
- It is a page, not a floating card: the head, the summary (requests / failures / mean latency / mean first token / mean tok/s / mean cache hit / connection reuse) and the filters stay put while the table scrolls. Each row carries time, model, session, input/output/cache, **cache hit**, **tok/s**, first token, latency and status; clicking one expands its HTTP detail (method, protocol, URL, body size, redacted headers, request shape, result and usage, reasoning split, cache writes, per-request cost, content span). Filters: model, result, slow requests, session; groups: session, model, result; **click a column head to sort by it**, click again to flip.
- **tok/s** is the output rate over the decode window (first token to the end), on the same scale as the Harness's own per-turn reading (reasoning tokens included). A request that produced no token has no rate — none is invented. **A burst delivery has no rate either**: when the gateway holds a whole turn and flushes it at the end (common with reasoning models: 8 seconds of thinking invisible on the wire, then a hundred tokens in a few milliseconds), a sub-100ms content span is delivery shape, not generation speed — it shows as — and stays out of the mean.
- The session column names the **session title** (from the session catalog; falls back to the id, whose full spelling stays one hover away). The session filter matches titles and ids; session groups are headed the same way. **Clicking a title opens that session** (an archived one refuses, and says so).
- **Cache hit** is the share of input tokens served from cache (cache reads over uncached input plus cache reads). No reported input means no share — none is invented either.
- **The In column is uncached new input**: the gateway reports a prompt as "uncached plus cache hits" and the log records only the new part — a fully prefix-cached turn reads as a tiny input with a 100% hit, which is not a bug. Hover a column head for its definition.
- **Content split**: below the body size the detail shows **Text X / Images Y** — images estimated as base64 per deduped attachment (each capped at the route's encoded target), text as the residual, so the two always sum to the total. Image-dominated turns read at a glance.
- Session ids are **always stored whole**: an id is a conversation identity, not a credential, and a truncated one reads two conversations as one.
- The log is a ring buffer (oldest dropped first) that dies with the process; snapshots are read on demand, never polled, so a page nobody opens costs no traffic.
- The credential never enters a record: the recorder takes no headers argument at all, only the allowlisted session id and user agent. Failed requests are recorded with their error code; a request cut off before any terminal event is not recorded — no total reported, none invented.

**Images**: an over-budget image is refused explicitly rather than silently downscaled or dropped. The budgets ride one preset `imageBudgetPreset` (three choices, default `dsh`), not three numbers:

| Preset | Per-image pixels | Per-image bytes (pre-base64) | Whole-request bytes (post-base64) |
| --- | --- | --- | --- |
| `dsh` (default) | 2048×2048 | 1MB | 20 MiB |
| `dshopencodego` | 1.44M px | 400 KB | 6 MiB |
| `pi-ai` | 2000×2000 | 4.5MB | 20 MiB |

A model that does not accept image input is rejected before the request is sent (`UNSUPPORTED_CONTENT`), so nothing is uploaded only to be refused by the gateway.

**Output cap**: a caller's own `maxTokens` travels as given, still clamped by a `modelLimits` ceiling. When a caller names none, the host materializes the route's ceiling — the catalog's output capacity, or whatever `modelLimits` overrode it with.

**Tool declarations**: every request carries the complete current tool list. The session-folded history the host offers (`toolHistory`) is deliberately **not** projected: projecting it requires the route to declare a `toolUpdate` mode, and models.dev states no such mode for this gateway's models (only that tools are callable). Claiming one would silently change what the model sees.

**Retries**: `retryPolicy` is optional — omit it and the host's own default applies. When set, the optional `dsh-llm-retry` plugin executes it, and a malformed policy fails where it is written rather than at the first failure.

**Fixed IP**: `pinnedAddresses` pins the gateway's name to one address, so the requests reach a closer edge — the edge the system resolves to is sometimes far away, and every request pays for that distance.

- **Only the resolution changes**: the name in the request, the host header, the TLS SNI and the certificate check all stay as they are; only the address in the socket is decided. The address therefore has to serve that name, because the certificate is issued for `opencode.ai`.
- **Only the gateway's own name counts**: the key must be the host of `baseURL` (`opencode.ai` by default). No other name is on this plugin's request path, so a pin for one has no effect. `models.dev` and the provider's documentation always use the system DNS.
- **Where it applies**: the model API request, the gateway listing (`/models`), and the `/usage` reading — the three requests that go to the gateway.
- **A gone address falls back**: when the pinned address cannot be reached (connection refused, route unreachable, TLS handshake failed), the request is sent **once more** through the system DNS, and the address is remembered as spent so the later requests go straight to the system's resolution. **A wrong address never costs more than no address**: only a request that was never sent is sent again.
- **Unset means untouched**: with no `pinnedAddresses`, the plugin uses the system's own fetch and adds nothing to it.
- **An address that is not an address is ignored**: a typo (`1.2.3.256`, `010.1.1.1`, …) does not fail the request; it is ignored and the request uses the system DNS.

The settings page (**OpenCode Go → Fixed IP**) writes the address for the gateway's current host, refuses an invalid one on the spot, and says "using the system DNS" once the address has been found to be gone.

## How a model is resolved

Four evidence levels decide how a model is called, first hit wins:

1. **The pi-ai catalog entry** — protocol plus wire quirks (DeepSeek's `thinkingFormat`, for example). This catalog is **compiled into the bundle**, so it only moves when the plugin is released.
2. **models.dev's per-model `provider.npm`** — `@ai-sdk/openai` → Responses, `@ai-sdk/anthropic` → Messages, absent → Chat Completions.
3. **Family rule** — `grok*`/`gpt*`/`muse-*` → Responses, everything else → Chat Completions.
4. **`modelProtocols` override** — always wins.

The gateway's `/v1/models` answers only *which* models exist, never *how* to call them. Inferred decisions are labelled in the settings page; override them with `modelProtocols`.

## A common question: does the provider adding or retiring a model need a plugin release?

**No — the model list is live.** The gateway's `/v1/models` is the only source of membership, and every catalog refresh (a 60-minute cache by default, or the Recheck button) takes it as the truth:

- a model the provider **adds** appears on the next refresh; if no metadata source describes it, it is labelled as inferred and can be pinned with `modelProtocols`;
- a model the provider **retires** disappears on the next refresh;
- the bundled catalog is **frozen at the plugin's version** and affects only the quality of the "how to call it" decision, never *which* models exist.

When the gateway is **temporarily unavailable**, the plugin keeps the last listing that succeeded, marks it stale on the page, and retries in the background. The retry rate is governed by a **five-minute back-off** rather than by the TTL, so a gateway that comes back is picked up within five minutes; while it stays down it is asked once, not once per model request. The settings page's Recheck button revalidates at any time and is not bound by that back-off.

The only thing that waits on a plugin release is a missing wire quirk in the pi-ai catalog (DeepSeek's `thinkingFormat`, say) — the model itself is already usable.

## The model list in the settings page

The "OpenCode Go" section shows the live gateway catalog (the count follows the gateway) with, per model:

- **context / max input / max output**, **release date**, **price per 1M tokens** (from models.dev), and **Go allowance**;
- **Go allowance** is fetched at runtime from the provider's own documentation — the "usage limits / estimated requests" tables, whose source is a markdown file in the provider's repository (GitHub first, jsDelivr second) — and refreshes with the catalog every 60 minutes. A failed fetch keeps the last successful parse; a process that never succeeded uses the **built-in snapshot** and the page says so, with the transcription date (`src/go-limits.ts`, frozen, not maintained by hand). A moved or restructured document counts as a failed fetch, never as an emptied column;
- **Input modalities**: a separate line lists the input modes models.dev declares (text / image / audio / video / PDF). These are the **model's own metadata**, not what the Harness can forward — the Harness sends text and images natively; audio/video/PDF travel as attachments and tool reads. The line is absent when the document declares none.
- filtering (by name/id, enabled-only, show-deprecated — **deprecated hidden by default**), sorting (newest first, monthly requests, input price, context, name, enabled first); the list is the only view, one model per row.

**Default switches**: `modelVisibility` is **per model** — an id listed with `true`/`false` follows that explicit value, and **ids you do not list still follow the default rule**: the **top five models by published monthly request estimate** are enabled (deprecated, unconfigurable, and training-"contributor" models never qualify) and the rest stay off. That top-five set is recomputed unconditionally on every catalog refresh, whether or not any explicit entry exists. The Host picker and the settings page compute this from one rule, so they never disagree. **The consequence**: once you write any explicit entry, a model the gateway adds later is **not** automatically visible unless it lands in the top five — add `id: true` for it explicitly.

## Usage

- **Quota windows**: `GET /usage` reports 5-hour / weekly / monthly percentages with reset times and rate-limit flags; a failed read keeps the last reading and marks it stale, and an account or endpoint change invalidates it.
- **Actual spend**: the in-conversation button reports calls and tokens (input/output/cache-read) this process spent since it started, from the usage the provider returns on each call. The gateway publishes no per-model tokens, so the numbers are labelled for what they are instead of faking a per-model quota.
- **Estimated cost**: models.dev per-million-token rates multiplied by the tokens the provider returned — an **estimate, not a bill**. On the subscription endpoint (Go) it is indicative only; it is only reconcilable on the metered Console endpoint. The rate is captured per call, so a catalog refresh never reprices tokens already spent; when the catalog publishes no separate cache rate, cached tokens are estimated at the **input** rate (an upper bound). **A model with no published rate shows "unpriced" with its name — never `0`, which would read as free.** Very small amounts render as `<$0.0001`.
- **Reasoning tokens**: the thinking tokens a provider reports are a **subset of `outputTokens`**, so they are shown on their own line but **excluded from the total** (adding them would count the same tokens twice). A model that reports no breakdown hides the line — that means "no data", not `0`.

## Compatibility

**Supported**: DSH `0.2.0` releases (`0.2.0-rc.1` and later) and the `0.2.1` line. `engines.dsh` and every `@deepseek-ai/dsh-*` peer dependency declare `>=0.2.0-rc.1 <0.3.0-0`.

**Anything before `0.2.0` is no longer supported**: support for the `0.1.7` line and older was removed in v0.1.36 — the runtime seam across that range differs from the one this plugin is built against, and continuing to declare it would only let the gate admit an untested combination. (`0.1.8` and `0.1.9` were never published.)

**The mechanism (not a hard pin)**: before mounting a plugin, DSH reads its `package.json` declarations and semver-checks the **running DSH version** against them (prereleases participate, i.e. `includePrerelease`). There are two levels, first match wins:

1. **`engines.dsh` takes precedence and decides alone**: when a plugin declares it, only that range is consulted and `peerDependencies` plays no part at all (DSH source `packages/boot/app-boot/src/plugin-compatibility.ts` returns as soon as it finds `engines.dsh`).
2. Only when a plugin declares **no** `engines.dsh` are the `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer ranges checked, one by one.

The verdict:

- satisfied → the plugin loads;
- not satisfied → **that plugin row is disabled with a printed reason** (`Plugin … is incompatible with dsh …`), leaving other plugins untouched;
- to take the risk anyway, grant an **exact-version exemption**: `dsh plugin --profile <profile> allow-version <pkg>@<version> --dsh-version <exact> --accept-risk` (applies only to that package and that exact runtime version); `dsh plugin --profile <profile> version-exemptions` lists what a profile holds.

**This plugin declares `engines.dsh`, so that is the range the gate enforces**; the peer ranges are a declaration for readers and package managers, and only take over the verdict if `engines.dsh` is removed. The upper bound is written `<0.3.0-0` rather than `<0.3.0` precisely because the check includes prereleases: `<0.3.0` would judge `0.3.0-rc.1` and its siblings **compatible** and let them load, while `<0.3.0-0` closes the whole `0.3.0` line. `@deepseek-ai/cordis` is declared separately as `4.0.4 || 4.0.5-alpha.1 || 4.0.5-alpha.2 || 4.0.5` — the runtimes used by DSH `0.2.0-rc.1`/`rc.2`, `0.2.1-alpha.1`/`alpha.2`, `0.2.1-alpha.3`–`alpha.5`, and `0.2.1-rc.2` respectively (`4.0.2`/`4.0.3` were dropped along with pre-`0.2.0` support).

**Outside the declared range**: everything before `0.2.0-rc.1`, and the whole `0.3.0` line (prereleases included), are refused. If the seam is compatible, widen or drop this plugin's **`engines.dsh`** in your own build — widening the peer range does nothing, since it takes no part in the verdict — or wait for a plugin release.

### Version-binding notes

| Binding layer | Declared | Enforced by |
| --- | --- | --- |
| `engines.dsh` | `>=0.2.0-rc.1 <0.3.0-0` | **DSH's gate at plugin load time; declaring it skips the peer verdict entirely** |
| `peerDependencies` (20 `@deepseek-ai/dsh-*` packages) | all `>=0.2.0-rc.1 <0.3.0-0` | takes over only when `engines.dsh` is absent; this plugin declares it, so the peers take no part today |
| `@deepseek-ai/cordis` | `4.0.4 \|\| 4.0.5-alpha.1 \|\| 4.0.5-alpha.2 \|\| 4.0.5` | the same peer channel |
| `engines.node` | `^22.19.0 \|\| >=24.0.0` | the package manager |
| bundled `@earendil-works/pi-ai` | `~1.4.0` (within 1.4.x), **compiled into `lib/`** (devDependency) | an independent coupling: a change in pi-ai's request construction changes this plugin's wire behaviour, and its opencode-go builtin catalog is this plugin's fallback data. Bundling leaves the plugin with **no runtime dependencies** for an installer to resolve |
| bundled `@deepseek-ai/schemastery` | `~3.18.5-alpha.2`, **compiled into `lib/`** (devDependency) | a build-time dependency |

Things to keep in mind when maintaining this:

- **Required versus optional peers**: nine of the twenty-one are marked `optional` (`dsh-api-remotes`, `dsh-client-locale`, `dsh-client-store`, `dsh-client-ui-layout`, `dsh-client-ui-model-selection`, `dsh-client-ui-primitives`, `dsh-client-ui-settings`, `dsh-client-ui-sidebar`, `dsh-client-ui-slots`). The other twelve are required at runtime: `cordis`, `dsh-attachment`, `dsh-brand`, `dsh-client-ui-conversation`, `dsh-client-ui-renderer`, `dsh-credentials`, `dsh-fs`, `dsh-launch-environment`, `dsh-llm`, `dsh-timeout`, `dsh-typert-protocol`, and `dsh-typert-registry`. None of the twenty-one takes part in the load verdict today (see above: `engines.dsh` decides alone); their value is declaring the dependency for the package manager and for readers. `dsh-llm` is the heaviest coupling — more than twenty imports across the source.
- **Declared range ≠ verified range**: the declaration is `>=0.2.0-rc.1 <0.3.0-0`. What was actually verified here, in order, is `0.2.0-rc.1` (the dev-dependency baseline: gate verdict + typecheck + full suite), `0.2.0-rc.2` (the same plus a `prepareCall` generation freeze), `0.2.1-alpha.3` (the first target release), `0.2.1-alpha.4` (T-24), `0.2.1-alpha.5` (T-26), and `0.2.1-rc.2` (T-31, where the runtime moved to cordis `4.0.5`; the upstream contract layer had zero source changes). Other versions inside the range were not verified one by one.
- **The upper bound is a tracking line**: `<0.3.0-0` means that the moment DSH ships `0.3.0-0` (the first prerelease on the `0.3.0` line), this plugin must ship a new release in the same window or every user loses the plugin. `tests/peer-coverage.spec.ts` asserts both ends — the lower bound accepts the installed version, the upper bound rejects `0.3.0-0` — so a drift here fails locally instead of failing on a user's machine. After changing a range, `npm test` is the verification (local mock gateway, no network, no tokens) — ranges follow what the interfaces declare, and are never "measured" with live probes.
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
| A flood of `Accessing non-existent property 'Allow' of module exports inside circular dependency` | Caused by `pi-ai`'s **named import** of `partial-json`: resolving a named export from CommonJS enumerates the module's exports, and that package's `index.js`/`options.js` require each other, so reading `Allow` before its module initialises prints once per read — **a plugin reload turns it into a flood** (a restart usually clears it). **Removed at the mechanism since v0.1.38**: `pi-ai` and `partial-json` are now **compiled into the bundle**, so Node's ESM→CJS interop is not involved and there is no enumeration of an uninitialised export to begin with. That is a fix, not a filter. |
| The whole DSH process stalls during ultra-long tool calls (multi-MB arguments) | Observed on pi-ai `0.87.1`: per-delta re-parsing of the accumulated arguments (issue #9265 / PR #9461). This plugin does not port DSH's consumer-side patch (ADR-0005); the bundled dependency is now `~1.4.0`, so a recurrence would be upstream behaviour and would be fixed by an upstream release. |

## Development

```sh
npm ci
npm run lint        # oxlint: static checks (the release workflow runs this too, and fails on it)
npm run typecheck   # both halves: host and client
npm run build       # build first: emits lib/index.js and lib/client.js
npm test            # contract tests against a real local HTTP mock gateway
```

**Order matters**: `npm run build` must come before `npm test` — `tests/pack-contents.spec.ts` walks every `exports` target, and whether `lib/` exists decides whether that check runs or is silently skipped (it does not fail, it just stops protecting you). `package.json` no longer carries `prepare`, so `npm ci` will not build for you; all three CI workflows run `npm run build` explicitly.

The suite covers configuration validation, the protocol ladder, gateway and online metadata, the catalog projection, the adapter on the wire (all three protocols), Remote contracts and services, session-header invariants, usage windows and the meter, the client controller and usage pill, both halves' mounting and registration, the error mapping for stream idle timeouts and aborts, the exit-code contract of the verification scripts, and several **structural invariants** (inject declarations match the source's reads, peer coverage holds both ways, the READMEs match the manifest, and the READMEs' claims about the upstream match the upstream actually installed). That is **59 test files** — a number `tests/readme-consistency.spec.ts` checks against the `tests/` directory, so it cannot drift.

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
