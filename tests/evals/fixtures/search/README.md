# Search quality fixtures

Offline / on-demand retrieval eval against the live public `/v1/search` API.

## Intent

Unit tests already cover hybrid plumbing (degrade, recency math, filters). This
suite grades **relevance** with soft expectations — org/catalog slugs in top‑k,
release title/summary keyword hits — not brittle `rel_` IDs.

Cases are mined from production `search_queries` (entity typeahead completions
and concept queries) plus a few synthetic concept/feature prompts agents use.

## Run

```bash
# Against prod (default)
bun run eval:search

# Staging / local API
RELEASES_API_URL=https://api.staging.releases.sh bun run eval:search

# Also score lexical + semantic for each case (mode comparison report)
SEARCH_EVAL_COMPARE_MODES=1 bun run eval:search
```

No API key required for anonymous search. Results land in
`~/.releases/evals/results/search-*.json` (see `tests/evals/results.ts`).

## Severity

| `severity` | Effect                                                        |
| ---------- | ------------------------------------------------------------- |
| `must`     | Failure counts against the pass gate                          |
| `should`   | Reported; does not fail the gate (known hard / stretch cases) |

## Case schema

See `cases.json`. Matchers live in `tests/evals/search.eval.ts`.

## Matchers

| Field                 | Purpose                                                    |
| --------------------- | ---------------------------------------------------------- |
| `anyOrgSlugInTop`     | Soft: at least one target org in top‑k                     |
| `majorityOrgInTop`    | Harder: ≥`minFraction` (default 0.6) of top‑k share `slug` |
| `mustNotOrgSlugInTop` | Pollution guard (e.g. ban `langfuse` on entity lookups)    |
| `anyTextContainsAny`  | Keyword/phrase in title/summary/name                       |

## Health notes (baseline, 2026-07)

From a 30d `search_queries` sample + dual-mode spot checks:

- Embed coverage: releases ~97%, entities ~98%, chunks 100%
- Almost all traffic is `mode=hybrid`; degraded ≈ 0
- Web typeahead dominates (progressive prefixes: `oll` → `ollama`)
- Entity lookups: **lexical often cleaner** than hybrid for release ranking;
  pure **semantic is weak** on bare product names
- Empty vectors (`langfuse:test`) polluted hybrid #1 for vercel/ollama/stripe —
  search now drops empty-tier bodies via `@releases/search/content-quality`
- Concept queries: hybrid helps when FTS has no exact phrase; some concepts
  still return topical garbage (e.g. "headless browser scraping")
