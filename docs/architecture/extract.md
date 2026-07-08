# Large-body extract: tool-use loop

"Extraction" is the AI step that turns a fetched changelog body into structured release records. For most pages that's one model call with the whole body inlined — but a few sources publish megabyte-scale bodies where inlining everything costs $0.50+ per fetch to re-read years of unchanged history. This doc covers the two-tier fix: small bodies keep the one-shot `/v1/messages` call; large ones (>50K tokens) route through a multi-round tool-use loop where the model pulls only the body slices it needs. Any loop failure falls back hard to one-shot, so enabling the flag is strictly a cost optimization — it can never make an extraction fail where the legacy path would have succeeded.

## Why

A handful of sources (PostHog's `posthog.com/page-data/changelog/page-data.json` at 1.26 MB / ~155K tokens, similarly-shaped Gatsby/Next page-data JSONs, large rendered HTML blobs) were burning $0.50–$0.70 per extraction because the legacy path inlined the entire truncated body into a single prompt. 3+ years of history were re-sent on every fetch even though only the latest handful of entries are "new". Per-host transformers were stripped in #342 because the offenders are home-grown layouts that don't generalize.

Empirical distribution (90 days of `usage_log.operation="agent-ingest"` and `"ingest"` calls): bimodal. Main scrape path averages ~5K tokens/call across 803 calls; direct-fetch path lands at ~155K tokens for the two observed cases. Very few calls live in between. Setting the tier threshold at 50K catches roughly 0.6–0.9% of calls — the right ~1% to target.

## Tiers

`extractFromBody()` in `packages/adapters/src/extract/extract-from-body.ts` is the choke point. Everything that fetches a body (`run-direct-fetch.ts`, `run-agent.ts`) flows through it.

```text
extractFromBody(body, ...)
  │
  ├── useToolLoop && approxTokens > 50K ──► extractWithToolsAiSdk(body, ...)  [default]
  │       │                                 extractWithTools(body, ...)       [no aiSdkModel]
  │       │                                 (multi-round tool-use loop)
  │       ├── success  ─► return entries
  │       └── failure  ─► fall back to runOneShot
  │
  └── else ─► runOneShot(body, ...)    (legacy inline extraction — unchanged)
```

When `ExtractDeps.aiSdkModel` is set (the normal worker path — OpenRouter when `openrouter-enabled` + `EXTRACT_MODEL` + key are configured, otherwise Anthropic via `buildLaneAnthropicModel`), the tool-loop routes through `extract-with-tools-aisdk.ts`. The hand-rolled Anthropic SDK loop in `extract-with-tools.ts` remains only as a fallback when no AI-SDK model resolves.

The tier gate requires both `useToolLoop === true` (set by the caller from `env.EXTRACT_TOOLLOOP_ENABLED` or the per-source override `source.metadata.extractStrategy === "toolloop"`) AND the approximate token count exceeding `LARGE_BODY_TOKEN_THRESHOLD = 50_000`. Below the threshold, every body keeps taking the legacy path regardless of the flag.

## Tool-loop mechanics

Production runs the loop through AI SDK `generateText` (`packages/adapters/src/extract/extract-with-tools-aisdk.ts`), with provider-agnostic tool schemas and Anthropic cache breakpoints replicated via `providerOptions` + `prepareStep`. The legacy controller (`extract-with-tools.ts`) is the same contract on the direct Anthropic `/v1/messages` endpoint — used only when `aiSdkModel` is unset. Both register three tools:

| Tool                       | Offered when                            | Purpose                                                                                                                                                        |
| -------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extract_releases`         | always (terminal)                       | Ends the loop with extracted entries.                                                                                                                          |
| `get_slice(start, length)` | always                                  | Returns `body.slice(start, start + length)`, capped at 20K chars. Clamps out-of-bounds args.                                                                   |
| `query_json(path)`         | body parsed as JSON (strict or partial) | Runs a JSONPath expression via `jsonpath-plus`, returns matched subtree as JSON text, capped at 20K chars with an "N more items elided" marker when truncated. |

The body is held in Worker memory and only seen by the model through these tool calls. The initial user message is a **preview** computed deterministically:

- Canonical source URL + fetch URL + body length in chars + token estimate
- For JSON: a top-level schema sketch (keys, types, array lengths) walked to depth 2
- For HTML: first 2K + last 2K chars after stripping `<script>`, `<style>`, `<svg>`, `<nav>`, `<header>`, `<footer>`
- A one-line instruction on which tools are available

Partial-JSON recovery (`partial-json` npm package) handles the case where strict `JSON.parse()` fails — e.g. a body truncated mid-structure. Three outcomes surface as `extraction_mode` in `usage_log`: `toolloop` (clean parse), `toolloop:partial` (partial recovery; preview includes a "may be truncated at byte ~N" note), or `toolloop:no_sketch` (both parsers failed; only `get_slice` offered).

## Budget and fallback

Hard caps prevent runaway loops:

- `MAX_ROUNDS = 8` — maximum tool-use rounds before the force-emit turn fires.
- `MAX_TOTAL_TOOL_CHARS = 80_000` — maximum total chars returned to the model across all rounds (~20K tokens).
- `MAX_TOOL_RESULT_CHARS = 20_000` — per-call cap on individual tool results.

When `MAX_ROUNDS` is reached without the model calling `extract_releases`, one final "emit now" user message is pushed and we allow exactly one more round. If that still doesn't terminate, the loop throws `LoopFallbackError("max_rounds")`.

Every `LoopFallbackError` — plus any uncaught SDK error — falls back to `runOneShot` (the legacy path) and logs the reason. The fallback reason is persisted to `usage_log.fallback_reason` as one of:

- `max_rounds` — budget exhausted without a terminal call
- `tool_error` — a tool handler threw (malformed JSONPath, etc.)
- `no_terminal_call` — model emitted text-only response with no tool calls
- `max_tokens` — `stop_reason === "max_tokens"` inside the loop
- `sdk_error` — any other SDK exception

`hitMaxTokens` handling from the legacy path is preserved: when a response hits `max_tokens`, the content hash is not committed, so the next fetch can retry on the same body.

## Prompt caching

The multi-turn shape amplifies the value of explicit cache breakpoints. Each round's request includes the full prior conversation — without markers, every round re-pays for the same prefix at full rate. Explicit `cache_control: { type: "ephemeral" }` placement gives ~6–7× reduction on the prefix cost across an 8-round loop.

- System block carries a static `cache_control` marker (identical across all rounds).
- Most-recent `tool_result` block gets a moving `cache_control` marker on each new round. Prior markers are stripped (`stripCacheControlFromPrior`) so exactly one breakpoint is active at a time — Anthropic allows up to 4 but we stay conservative.
- Force-emit turn does NOT place a marker — it runs at most once and nothing re-streams from that state.

Cross-call caching (between separate extractions) is unchanged and remains low-value: per-source fetch cadence (≥4h tier intervals) almost always exceeds the 5-minute ephemeral TTL.

## Observability

Rollups come from two places, neither of them new:

- **Cloudflare AI Gateway** — per-request token/cost/latency for every Anthropic call through the gateway. See [ai-gateway.md](ai-gateway.md). No additional instrumentation required.
- **`usage_log` D1 table** — six new columns capture the extraction tier and inner-loop counters:

  | column               | purpose                                                                                                  |
  | -------------------- | -------------------------------------------------------------------------------------------------------- |
  | `extraction_mode`    | `"oneshot"` \| `"toolloop"` \| `"toolloop:partial"` \| `"toolloop:no_sketch"` \| `"fallback_to_oneshot"` |
  | `tool_rounds`        | Number of tool-use rounds before the terminal call (null outside the tool-loop tier).                    |
  | `tool_chars`         | Total chars returned to the model via tool_result (null outside the tool-loop tier).                     |
  | `fallback_reason`    | Populated only when `extraction_mode = "fallback_to_oneshot"`.                                           |
  | `cache_read_tokens`  | `usage.cache_read_input_tokens` from the Anthropic response (was previously unpersisted).                |
  | `cache_write_tokens` | `usage.cache_creation_input_tokens` (also previously unpersisted).                                       |

Structured stderr logs (`@buildinternet/releases-lib/logger`) emit one `info` line per extraction with mode, rounds, tool chars, cache read/write tokens, and entry count; one `warn` on fallback with the reason.

## Rollout

`EXTRACT_TOOLLOOP_ENABLED=false` by default, so flipping the branch on main is a no-op until the flag is set in a worker env. Two knobs for progressive rollout:

- **Per-source override** — set `source.metadata.extractStrategy = "toolloop"` to force the tool-loop tier for a specific source regardless of the env flag. Useful for eval/debug against known large bodies (PostHog, Turborepo, vercel-cli) before flipping the global default.
- **Global default** — set `EXTRACT_TOOLLOOP_ENABLED=true` in `workers/discovery/wrangler.jsonc` to enable for all sources whose body exceeds 50K tokens.

The AI Gateway dashboard surfaces cost/token deltas per call; SQL rollups on `usage_log` answer "what fraction of calls fell back" and "median `tool_rounds` for bodies > 100K".

## Files

- `packages/adapters/src/extract/extract-from-body.ts` — tier gate + `runOneShot` helper
- `packages/adapters/src/extract/extract-with-tools-aisdk.ts` — production loop (AI SDK; OpenRouter or Anthropic)
- `packages/adapters/src/extract/resolve-tool-loop-model.ts` — shared OpenRouter → Anthropic model resolver (`resolveToolLoopAiSdkModel`)
- `packages/adapters/src/extract/extract-with-tools.ts` — legacy Anthropic SDK loop + `LoopFallbackError`
- `packages/adapters/src/extract/preview-builder.ts` — JSON schema sketch (strict + partial) and HTML preview
- `packages/adapters/src/extract/tool-handlers.ts` — `handleGetSlice`, `handleQueryJson`
- `packages/adapters/src/extract/shared.ts` — tool schemas + loop constants
- `packages/adapters/src/source-meta.ts` — `extractStrategy` field on `SourceMetadata`

Original design doc: [docs/superpowers/specs/2026-04-24-large-body-extract-tool-loop-design.md](../superpowers/specs/2026-04-24-large-body-extract-tool-loop-design.md).
