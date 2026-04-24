# Large-Body Extract: Tool-Use Loop

**Date:** 2026-04-24
**Status:** Implemented — behind `EXTRACT_TOOLLOOP_ENABLED` feature flag (default off); pending eval-based rollout
**Area:** `packages/adapters/src/extract/`

## Problem

`extract-from-body.ts` inlines the entire fetched body (JSON/HTML) into a single `/v1/messages` call. For large monolithic sources — e.g. PostHog's `posthog.com/page-data/changelog/page-data.json` (1.26 MB on disk, ~155K input tokens after the existing 400K-char truncation) — a single extraction costs ~$0.65 and wastes ~95% of the tokens on content the model doesn't need (3+ years of history when we only want "what's new since the last fetch").

Bespoke per-host transformers (stripped in #342) don't generalize — most offenders are home-grown Gatsby/Next page-data layouts, each different. We need a generic way to let the model pull only the parts of the body it actually needs.

## Scope

All bodies flowing through `extract-from-body.ts`. That covers:

- `run-direct-fetch.ts` — JSON/HTML endpoints set via `source.metadata.fetchUrl`
- `run-agent.ts` — Cloudflare-rendered HTML via the scrape-agent path

Not in scope: the managed-agents discovery/worker sessions (different flow; already agentic).

## Design

### Tiered behavior

`extract-from-body.ts` gains a two-tier internal branch based on the body's approximate token count:

- **≤ tier threshold** → one-shot inline extraction, unchanged from today
- **> tier threshold** → new tool-use loop (`extract-with-tools.ts`), still on `/v1/messages`

`extractFromBody()`'s return shape is extended with telemetry fields (extraction mode, tool rounds, tool chars, fallback reason, cache read/write tokens); existing fields keep their semantics. Callers in `run-direct-fetch.ts` and `run-agent.ts` were updated to forward `sourceUrl` / `fetchUrl` / `useToolLoop` into the call and to persist the new telemetry via `logUsage`.

```
extractFromBody(body, ...)
   │
   ├─ approxTokens ≤ THRESHOLD ─► one-shot inline (unchanged)
   │
   └─ approxTokens  > THRESHOLD ─► extractWithTools(body, ...)
                                    │
                                    ├─ success  ─► return entries
                                    └─ failure  ─► fallback to one-shot inline
```

A hard fallback guarantees we never regress past today's behavior: if the tool loop errors, exceeds its budget without emitting `extract_releases`, or fails unexpectedly, we run the existing one-shot path and log the fallback reason.

### Threshold

**50K tokens** — reuse the existing `LARGE_BODY_TOKEN_THRESHOLD` constant. Investigation against the production `usage_log` table (`packages/core/src/schema.ts:228`) over a 90-day window shows the input-token distribution is strongly bimodal: the main `ingest` scrape path averages ~5K tokens over 803 calls, while the `agent-ingest` direct-fetch path's only observed calls (2 of them) land at ~155K. Very few calls live in the middle. At 50K, the tool loop fires for roughly **0.6–0.9% of calls** — the right ~1% to target. Borderline sources worth watching in the first week: `vercel-cli` (avg 46K/call), `cloudflare-workers-sdk` (47K), `turborepo` (39K) — some individual calls may cross 50K intermittently.

### Body-size caps

Today's `MAX_BODY_CHARS = 400_000` exists because the body is inlined into the prompt. Under the tool-loop tier the body is held in Worker memory (128 MB ceiling — trivial for a few MB of text) and only ever seen by the model through bounded tool calls, so the 400K cap no longer serves a purpose there.

- **One-shot tier:** keep `MAX_BODY_CHARS = 400_000`, unchanged — protects the inlined prompt.
- **Tool-loop tier:** raise cap to `MAX_BODY_CHARS_TOOLLOOP = 2_000_000` (~2 MB). PostHog's 1.26 MB file parses completely; partial-parse becomes a rare fallback rather than the common case.

### Preview (initial user message)

Deterministic, computed in-Worker, roughly 500 tokens. Contents:

- Canonical source URL + fetch URL
- Body length (chars), detected content type, total token estimate
- **JSON schema sketch** (when body parses as JSON, strict or partial) — top-level keys with types; every array's length; walked to depth 2. One shallow recursive pass, no extra libs beyond the partial-parse dependency.
- **HTML preview** (when body is HTML) — first 2K chars + last 2K chars after stripping `<script>`, `<style>`, `<svg>`, and common `nav`/`header`/`footer` tags. Cloudflare's browser rendering already cleans most of this; we just cap.
- A one-paragraph instruction describing the available tools and the expectation to call `extract_releases` when done.

**Partial-JSON recovery:** when strict `JSON.parse()` fails, try `partial-json.parse()` (well-maintained npm package that closes unbalanced brackets/strings; similar technique used by the Anthropic SDK for streaming tool-use). Three outcomes:

1. **Clean parse** → full sketch, `query_json` offered unrestricted. Logged as `toolloop`.
2. **Partial parse** → sketch from what was recovered; preview includes a note that the structure past byte ~N may be missing and the model should fall back to `get_slice` if `query_json` returns empty for deep paths. `query_json` still offered. Logged as `toolloop:partial`.
3. **Both parsers fail** → no sketch; only `get_slice` offered. Logged as `toolloop:no_sketch`.

### Tools

All three tools are registered on the stream for each loop iteration. `extract_releases` is the terminal tool (unchanged from today).

```ts
// Terminal tool — emitting this ends the loop with success.
extract_releases(input: { releases: ExtractedEntry[] })

// Always offered.
get_slice(input: { start: number; length: number })
  // Returns body.slice(start, start + length). Capped at 20_000 chars per call.
  // Negative / out-of-bounds args are clamped, not errored, to avoid burning a
  // round on a retry.

// Offered only when body parsed (strict or partial).
query_json(input: { path: string })
  // JSONPath via jsonpath-plus (or equivalent small dep). Returns the matched
  // subtree as JSON text, capped at 20_000 chars. When the match set exceeds
  // the cap, return the first N items plus a count-of-truncated-siblings marker.
```

Tool handlers live alongside the loop controller in `extract-with-tools.ts`, closing over the in-memory body. No network, no disk, no sandbox.

### Loop controller

```ts
const MAX_ROUNDS = 8;
const MAX_TOTAL_TOOL_CHARS = 80_000; // ~20K tokens of tool output

let rounds = 0;
let charsReturned = 0;

while (rounds < MAX_ROUNDS && charsReturned < MAX_TOTAL_TOOL_CHARS) {
  const msg = await stream.finalMessage();
  const toolUses = msg.content.filter((b) => b.type === "tool_use");

  const terminal = toolUses.find((t) => t.name === "extract_releases");
  if (terminal) return success(terminal, totals);

  // Handle get_slice / query_json calls, append tool_result blocks,
  // update charsReturned, re-stream.
  rounds++;
}

// Budget exhausted: push a final "you have seen enough, emit extract_releases now"
// user turn, allow ONE more round, then trigger fallback if still no terminal call.
```

Budget values (`MAX_ROUNDS = 8`, `MAX_TOTAL_TOOL_CHARS = 80_000`, per-call cap `20_000`) are starting points chosen to comfortably fit the PostHog-shape case (one `query_json` for the releases array, maybe one `get_slice` for context). Tune from the first week of AI Gateway data.

### Fallback triggers

Any of the following causes `extractionMode: "fallback_to_oneshot"`:

- `MAX_ROUNDS` exhausted with no `extract_releases`
- A tool handler throws (malformed JSONPath, library error, etc.)
- A round with no `tool_use` blocks (text-only response) — mapped to `no_terminal_call`
- `stop_reason === "max_tokens"` inside the loop or on the force-emit turn
- Any exception from the Anthropic SDK

On fallback we run the existing one-shot path, log the reason, and return its result. `fallbackReason` is one of `"max_rounds" | "tool_error" | "no_terminal_call" | "max_tokens" | "sdk_error"`.

### Prompt caching

In a multi-turn loop, each round includes the full prior conversation as input, so without cache markers every round re-pays for the same prefix at full rate. Explicit `cache_control` placement roughly 6–7× reduces the prefix cost across an 8-round loop.

- **System prompt block** — keep the existing `cache_control: { type: "ephemeral" }` marker already present in `extract-from-body.ts:65`. Identical across all rounds in a loop.
- **Tool-use / tool-result pair after each turn** — mark the most recent `tool_result` block with `cache_control: { type: "ephemeral" }` so the Anthropic API caches up to and including that turn. On the next round, move the marker forward (Anthropic allows up to 4 cache breakpoints; we'll keep just one active, at the end of the most recent turn).
- **Initial user message (preview)** — identical across all rounds. Either mark it directly or rely on the system-block cache to cover the common prefix. Simpler to not double-mark — the ephemeral cache on the system block already covers the initial turn; the moving breakpoint on tool_results extends coverage as the loop progresses.

Cross-call caching (between separate extractions) remains low-value and unchanged. Per-source fetch cadence (≥4h tier intervals) almost always exceeds the 5-minute ephemeral TTL. The win here is strictly within a single loop.

### Invariants carried over

- On `max_tokens` in either tier, the content hash is **not** committed — matches `hitMaxTokens` handling at `run-direct-fetch.ts:134`, so a retry runs on the same body.
- `logUsage` still fires exactly once per call. Input/output tokens are summed across every round of the loop. `cache_read_input_tokens` and `cache_creation_input_tokens` from the final `usage` response are already captured by the Anthropic SDK response shape — persisting them on `usage_log` is a pre-existing gap that's worth closing as part of this work so we can verify caching is actually landing.

## Observability

Rollups come from Cloudflare AI Gateway (per-request token/cost/latency, already captured) plus the existing `usage_log` table (`packages/core/src/schema.ts:228`). No new dashboards on our side.

New columns on `usage_log`:

| column               | type    | notes                                                                                                    |
| -------------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| `extraction_mode`    | text    | `"oneshot"` \| `"toolloop"` \| `"toolloop:partial"` \| `"toolloop:no_sketch"` \| `"fallback_to_oneshot"` |
| `tool_rounds`        | integer | Null outside the tool-loop tier.                                                                         |
| `tool_chars`         | integer | Total chars returned to the model across all tool calls. Null outside the tool-loop tier.                |
| `fallback_reason`    | text    | Populated only when `extraction_mode = "fallback_to_oneshot"`.                                           |
| `cache_read_tokens`  | integer | `usage.cache_read_input_tokens` from the Anthropic response (was previously unpersisted).                |
| `cache_write_tokens` | integer | `usage.cache_creation_input_tokens` from the Anthropic response (was previously unpersisted).            |

Structured stderr log (via `@buildinternet/releases-lib/logger`):

- One `info` on happy path — tier, rounds, chars returned, entries extracted.
- One `warn` on fallback — tier, `fallbackReason`, body length, source slug.

SQL rollups answer the questions we'll want in the first week: fallback rate, median `tool_rounds` for bodies > 100K, distribution of `extraction_mode` by source.

## Error handling

See _Fallback triggers_ above. Everything outside that list — content-hash match, 304 Not Modified, empty body, feed 5xx — continues to be handled at the `run-direct-fetch.ts` / `run-agent.ts` layer exactly as today. The tool loop is a drop-in replacement for the one-shot `anthropicClient.messages.stream(...)` call inside `extract-from-body.ts`.

## Testing

- **Unit tests** colocated with source under `packages/adapters/src/extract/` (`*.test.ts`):
  - Preview builder — JSON shape walk (strict + partial), HTML strip+truncate.
  - `get_slice` handler — clamping, length cap, empty body.
  - `query_json` handler — JSONPath hits, misses, cap-with-sibling-count.
- **Loop integration test** using a recorded Anthropic response fixture (mirrors the approach in existing adapter tests) — exercise happy path, `MAX_ROUNDS` fallback, tool-throw fallback, `max_tokens` fallback. Verify each lands in the right branch and logs the right `fallbackReason`.
- **Eval** stays manual (per AGENTS.md — evals cost money). One manual run against `.context/examples/page-data.json` and one known-huge HTML source after this lands will confirm the cost delta.

## Rollout

Dark-launch behind a feature flag or env var (`EXTRACT_TOOLLOOP_ENABLED`). Off by default → behavior identical to today. Enable for one or two chronic offenders via source-level opt-in (e.g. a `source.metadata.extractStrategy` hint), observe for a few days, then flip the global default. This leverages the existing tier gate — the flag only controls whether the tool-loop branch is taken for bodies above the threshold; bodies below stay on the unchanged one-shot path regardless.

## Files touched

- `packages/adapters/src/extract/extract-from-body.ts` — tier gate, call new path.
- `packages/adapters/src/extract/extract-with-tools.ts` — **new**, loop + tool handlers + preview builder.
- `packages/adapters/src/extract/shared.ts` — `MAX_BODY_CHARS_TOOLLOOP`, tool schemas, guidance strings for the tool-loop system prompt.
- `packages/core/src/schema.ts` — add six columns on `usage_log` (migration via Drizzle): four for extraction mode/telemetry, two for cache read/write tokens that were previously unpersisted.
- `packages/adapters/src/extract/*.test.ts` — colocated unit + integration tests per _Testing_ above.
- `packages/adapters/package.json` — new deps: `partial-json`, `jsonpath-plus` (or chosen equivalent).

## Open items

1. **JSONPath library choice** — `jsonpath-plus` is the obvious default, but the library landscape has a few small alternatives worth a two-minute look when we start implementation.
2. **Feature-flag shape** — env var vs. per-source metadata vs. both. Simplest is a single env var; per-source is better for targeted dark-launch. Recommend both: env var gates globally, per-source metadata forces the tool loop for specific sources regardless of body size (useful for eval/debug).
