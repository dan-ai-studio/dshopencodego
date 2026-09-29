# Verification: what costs money and what does not

Everything in `npm test` runs hermetic — 172 cases against the local mock
gateway plus injected documents, zero network, zero tokens. That is the
default way to prove a change. In particular no unit or integration test may
send a real gateway request: `OpencodeGoAdapter` accepts an optional
`readDocument` precisely so adapter-level suites inject `offlineDocument()`
instead of fetching the provider documentation, and `stubModelsDev` only
stubs `models.dev` because nothing else in the suite is allowed to need the
network at all.

Only the scripts in this folder touch the real gateway, and a real gateway call
spends the account's money. The rules below are not stylistic; they exist so a
verification pass cannot quietly become a bill.

## Rules

1. **Default to zero live requests.** Unit tests plus the mock gateway prove
   request bodies, headers, catalog parsing and error mapping. Only a question
   about the *gateway's* behaviour needs a live call.
2. **One live request per release at most**, with a one-word prompt and
   `PROBE_MAX_TOKENS` left small (default 64, cap 256). Both live scripts
   price the probe from the installed pi-ai catalog first (`cost-guard.mjs`):
   worst case assumes the token cap plus reasoning headroom, and anything
   above $0.01 — or with no published price at all — refuses unless the
   caller also passes `--allow-expensive`. A price hike or an expensive
   model trips here instead of on the bill.
3. **Never sweep a model list.** A batch probe across models is a bill, not a
   test: state the number of requests and get the user's go-ahead first, and
   prefer the cheapest model that can answer the question.
4. **Reuse the measurements below.** These were paid for; they are recorded so
   nobody pays twice. A behaviour that is not listed here and not covered by
   the mock gateway needs a decision, not a spontaneous probe.
5. **400s and stalls are free.** A rejected request and a timed-out stream
   produce no tokens, so acceptance-only checks (does the gateway validate this
   parameter?) are the cheapest kind of live call.

**The code follows the interfaces, not these measurements.** A reasoning level
exists only when models.dev or the installed catalog states one; a document that
names none produces no control and no `reasoning_effort` on the wire. Nothing
below feeds the implementation — it is a record, so a future question can be
answered from evidence already paid for instead of a new probe.

## Measured gateway behaviour (2026-09-25)

`reasoning_effort` acceptance, one streaming request each, max_tokens 16-64:

| model | accepted | rejected |
| --- | --- | --- |
| mimo-v2.6-flash / mimo-v2.6-pro / mimo-v2.5 / mimo-v2.5-pro | no parameter, `low`, `medium`, `high` | `minimal`, `off` (400) |
| minimax-m2.5, kimi-k2.6, kimi-k2.7-code, glm-5.1 | `low`, `medium`, `high` | — |
| longcat-2.0 | `high`, `off` | — |
| qwen3.7-max, qwen3.8-max, qwen3.8-flash | `high` | `off` (400) |
| hy3 | `none` (its documented off spelling) | — |
| deepseek-v4-flash | `off` | — |
| deepseek-v4-flash-vision-exp, kimi-k2.6 | — | `off` (422 / 400) |

Availability, independent of any parameter: `mimo-v2-omni`, `glm-5`, `kimi-k2.5`,
`mimo-v2-pro` answer 400 "Model is unavailable"; `minimax-m2.7` answered 503
"Endpoint is unavailable". `mimo-v2.6-flash` intermittently accepts a connection
and then streams nothing for over a minute — gateway-side, reproducible with a
bare `curl` and no plugin involved.

What this bought the code: undocumented models (the MiMo family and friends)
offer exactly `low`/`medium`/`high`, and no model is promised an `off` the
transport cannot spell. See `src/catalog/metadata.ts`.

## Scripts

| script | spends money | use |
| --- | --- | --- |
| `model-probe.mjs` | yes, one request, needs `--allow-live` + price check | confirm a gateway rejection or a wire spelling |
| `live-check.mjs` | yes, one request, needs `--allow-live` + price check | end-to-end check of catalog + session header |
| `cost-guard.mjs` | no | shared price ceiling imported by the two scripts above |
| `recording-proxy.mjs` | no by itself | logs request bodies; forwards whatever asks it to |
