---
name: generating-release-content
description: >
  Generate the AI fields on releases — `title_generated`, `title_short`,
  `summary`, and `composition` — for one release, a window, or a backfill,
  via Claude Code sub-agents and direct SDK calls. Use when iterating on
  prompts, running provider/model experiments, or filling in a
  small-to-medium backfill outside the production ingest path or the
  Batches API. (Managed agents can spawn sub-agents now too; the dispatch
  scaffolding for this skill just isn't wired up on that side yet.)
---

# Generating Release Content

Populate the four AI-generated fields on a release:

- `title_generated` — self-contained news headline (60–90 chars, hard cap 100)
- `title_short` — Axios "smart brevity" headline for chrome-stripped surfaces
- `summary` — 1–2 sentence prose blurb
- `composition` — `{bugs, features, enhancements}` counts (stored on `releases.metadata.$.composition`)

The fields are the same whether you're generating for the first time or rewriting after a prompt change. There is no "new vs. regen" branch in the pipeline — last write wins.

## Prompt is canonical in code, not in this skill

The system prompt and all parsing rules live in `packages/ai/src/release-content.ts`. Read it directly; do **not** paraphrase it back into the user message. The same module is consumed by the ingest worker (`workers/api/src/workflows/poll-and-fetch.ts`), the Batches script (`scripts/generate-release-content.ts`), and this skill, so any drift between local-agent output and ingest-time output starts there.

Re-export from that file:

- `SYSTEM_PROMPT` — pass verbatim as the system message, with `cache_control: { type: "ephemeral" }`
- `buildReleaseBlock(input)` — build the user message body from a `SummarizeReleaseInput` (org slug, source name, product name, title, version, url, content)
- `isEmptyContent(body)` — short-circuit boilerplate-only bodies; skip the model and write NULLs
- `parseReleaseContent(text)` — pull `<title>`, `<title_short>`, `<summary>`, `<composition>` out of a response
- `MODEL` (`claude-haiku-4-5`), `MAX_OUTPUT_TOKENS` (280), `MAX_BODY_CHARS` (8000)

For experiments that change the prompt, edit `SYSTEM_PROMPT` in place on a branch and run this skill against a small org — that's exactly what the upstream module exists for.

## When to Use

- **Backfill before/after flipping a new org's `auto_generate_content` opt-in.** Forward-going generation is automatic; pre-existing rows aren't touched until something regenerates them.
- **Prompt iteration.** Try a prompt change against ~5–20 recent releases on a known org, compare side-by-side, decide whether to ship.
- **Provider / model bake-offs.** Re-run a fixed candidate set across providers using the same `buildReleaseBlock` input.
- **Patch-ups after an ingest hiccup** — e.g. the model returned malformed XML and the inserted row has nulls, or a known prompt bug was fixed and a 24-hour window needs a sweep.

When **not** to use this:

- **Large backfills (>200 rows).** Prefer `bun scripts/generate-release-content.ts --orgs=… --since=… --apply`. The Batches API gives a 50% discount and runs offline; local sub-agents pay full price and consume your session's token budget.
- **Live ingest gaps.** The poll-fetch workflow already generates content at ingest time when the org is opted in. If new rows are landing with nulls, the bug is in the worker, not in this skill.

## Step 1: Pick candidates

D1 is remote-only in this repo. The script uses `wrangler d1 execute … --command`; do the same here. Typical filters:

```bash
# Missing-short rows for one or more orgs, past N days
bunx wrangler d1 execute released-db --remote --config workers/api/wrangler.jsonc \
  --command "
    SELECT r.id, r.title, r.version, r.url, r.content,
           o.slug AS org_slug, s.name AS source_name, p.name AS product_name
    FROM releases r
    JOIN sources s ON s.id = r.source_id
    JOIN organizations o ON o.id = s.org_id
    LEFT JOIN products p ON p.id = s.product_id
    WHERE r.suppressed = 0
      AND r.title_short IS NULL
      AND o.slug IN ('notion','figma','neon','planetscale')
      AND r.published_at >= date('now','-30 day')
    ORDER BY o.slug, r.published_at DESC;
  " --json
```

The select list is exactly what `buildReleaseBlock` expects. Other useful predicates:

- `r.title_generated IS NULL` — backfill self-contained titles only
- `metadata->>'$.composition' IS NULL` — composition gap
- `r.fetched_at >= '<iso>'` — recent ingest sweep
- `r.id IN ('rel_…','rel_…')` — explicit ad-hoc set

For experiments, write the candidate set to disk so the same input is reused across runs:

```bash
… --json | jq '.[0].results' > /tmp/candidates.json
```

## Step 2: Choose execution mode

Three modes, pick by candidate count:

| Count  | Mode                               | Model      | Why                                                                                                      |
| ------ | ---------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------- |
| 1–10   | **Inline** (parent calls SDK)      | Haiku 4.5  | Mirrors production ingest exactly (`summarizeRelease()`). Best for parity experiments.                   |
| 10–200 | **Parallel sub-agents**            | **Sonnet** | The agentic loop benefits from stronger reasoning around the long instruction-tuned prompt.              |
| 200+   | **Delegate to the Batches script** | Haiku 4.5  | Same model as production; 50% Batches API discount; ~24h latency. `scripts/generate-release-content.ts`. |

**Why Sonnet for sub-agents but Haiku for the other two modes:** the production ingest path is a single-shot Anthropic API call (`summarizeRelease()` in `packages/ai/src/release-content.ts`) — Haiku 4.5 is great at that. A Claude Code sub-agent is _not_ a single-shot call; it's an agent loop that loads the SYSTEM_PROMPT from a file, narrates, and applies the rules across multiple turns. In a 4 vs 5 row Sonnet/Haiku A/B run on production candidates, Sonnet sub-agents were 4/4 clean; Haiku sub-agents were 3/5 — the two failures were a forbidden `"Neon blog:"` title prefix and a wrongly-null composition. The model difference vanishes once you drop the agent loop and call the SDK directly (Mode A / Mode C), which is why those modes use Haiku.

### Mode A: Inline (1 release at a time)

The parent — you — is the inference. No `Agent` dispatch. For each candidate row:

1. Build the input with `buildReleaseBlock(row)` from `@releases/ai-internal/release-content`.
2. Call `summarizeRelease(client, input)` from the same module — this _is_ the production codepath. Pass an Anthropic client constructed against `ANTHROPIC_API_KEY` (the parent has env access; sub-agents do not).
3. Write via the CLI (see Step 3).

This is the parity-experiment mode. Output matches what the ingest worker would write byte-for-byte, because it's running the same module with the same model.

For _prompt iteration_ (you want to test a SYSTEM_PROMPT change), edit `packages/ai/src/release-content.ts` on a branch and re-run Mode A — that's how the upstream module is designed to be tweaked.

### Mode B: Parallel sub-agents (10–200 releases)

Pattern mirrors `seeding-playbooks` and `maintaining-orgs`: dispatch N agents in a single message, have them return content inline (not via the CLI), parent writes the rows.

**Why parent-writes:** dispatched sub-agents commonly hit permission denials on `Bash`/`Write` against arbitrary CLI commands. The two existing batch skills both ran into this; the workaround is to make sub-agents return the four fields in a structured payload and let the parent run the CLI.

Batch size: 10 releases per sub-agent is a reasonable upper bound. Larger batches risk truncation; smaller wastes context-loading. Run at most 10 sub-agents in parallel; queue the rest.

Prompt template (one agent, N releases):

````text
Generate AI fields for {N} release rows from the Releases registry.

Read these two files first:
1. `packages/ai/src/release-content.ts` (absolute path) — contains the canonical
   SYSTEM_PROMPT and the four output tags (<title>, <title_short>, <summary>,
   <composition>). Apply that prompt verbatim — do not paraphrase.
2. `{path to candidates JSON}` (absolute path) — the {N} rows to process.

For each row, build the user message per `buildReleaseBlock` (Org / Source /
Product? / Title / Version? / URL? / blank line / Body:), apply the
SYSTEM_PROMPT, parse the four output tags, and produce the JSON described
below. Apply `isEmptyContent`'s logic before generating — if a row would
short-circuit, return all-null fields with `skipped: true`.

OUTPUT CONTRACT — non-negotiable:
- Your final message must contain NOTHING except one fenced ```json block.
- No analysis, no narration, no reasoning steps, no preamble, no "Here is",
  no commentary after.
- If you need to reason, do so silently — your final message is JSON-only.
- A strict parser pulls the first fenced ```json block out of your output;
  anything outside is discarded but counts against quality scoring.

JSON shape:

~~~json
[
  {
    "id": "rel_…",
    "title": "…" | null,
    "titleShort": "…" | null,
    "summary": "…" | null,
    "composition": { "bugs": N, "features": N, "enhancements": N } | null,
    "skipped": false
  }
]
~~~

Rules:
- title.length <= 100. titleShort.length <= 70.
- Convert any empty-string field to null (the API stores empty as text, not NULL).
- composition is null when all three counts would be zero.
- skipped: true ONLY when isEmptyContent would short-circuit — then all four
  fields are null.

Do not run `releases admin release update` or curl PATCH — the parent writes.
Do not read .env or call provider SDKs. Do not look up external context.
````

A few notes on this prompt that observed runs proved out:

- **Pass file paths, not inlined JSON.** `$(cat …)` shell substitution leaks into the prompt as text; sub-agents _usually_ interpret it as "read this file", but explicit `Read` instructions are more reliable. Inlining JSON in the prompt body also blows up the prompt size on larger batches.
- **The no-preamble contract is best-effort.** Even with the tightened wording above, both Sonnet and Haiku sub-agents narrate before the JSON in their final message ~70% of the time. The lint pass below assumes lenient extraction (first fenced ```json block wins) rather than strict "JSON-only final message".

Dispatch:

```typescript
// One Agent() call per batch of up to 10 candidates; send all calls in a
// single message for maximum parallelism. model: "sonnet" — the A/B run
// against Haiku showed Haiku-as-agent narrating more and occasionally
// misapplying the prompt (forbidden title prefixes, wrongly-null composition).
// Haiku is the right model for the SDK path (Modes A and C); not the
// agent-loop path.
for (const batch of chunkOf(candidates, 10)) {
  Agent({
    description: `Generate release content (${batch.length} rows)`,
    model: "sonnet",
    run_in_background: true,
    prompt: buildBatchPrompt(batch),
  });
}
```

After each agent returns, lint the payload before writing:

- Extract via "first fenced ```json block in the final message"; tolerate preamble.
- Reject rows where `title.length > 100` or `titleShort.length > 70` (hard caps from the prompt).
- Reject rows whose `title` or `titleShort` leads with an attribution prefix like `Blog:`, `Changelog:`, or `<Org> blog:` — the prompt's news-headline style doesn't allow them. Observed Haiku failure mode.
- Reject `composition` rows where any count is negative or non-integer, or where all three are zero (the parse path treats `{0,0,0}` as no signal — drop the field). A `null` composition on a row whose body clearly describes features/fixes is also a reject (observed Haiku failure mode: rationalizing "not a changelog, so 0/0/0").
- Reject rows where any non-null field starts/ends with quote characters or markdown bullets — the prompt explicitly bans them.
- Convert any empty-string field to null before writing.
- Re-prompt or fall back to inline mode for rejects.

### Mode C: Batches script (200+ releases)

Don't reinvent. Run:

```bash
bun scripts/generate-release-content.ts --orgs=<slugs> --since=<days> --apply
```

The script handles candidate selection, empty-body short-circuit, batch submission, polling, budget guard (`--max-cost`, default $10), and per-row D1 writes. Use the local sub-agent path only when you specifically need it (prompt iteration, model bake-off, sub-200 patch-up).

## Step 3: Write the rows

The CLI surface is `releases admin release update <id>`:

```bash
releases admin release update rel_… \
  --title-generated "OpenAI Codex 2.35 added local-only mode" \
  --title-short "Codex now runs fully offline; SSO breakage fixed" \
  --summary "Codex 2.35 adds an offline mode that runs without provider API access; fixes the SSO regression introduced in 2.34."
```

Empty string clears the field (writes NULL). `--dry-run --json` returns the diff without writing — useful for the lint pass before a bulk run.

**Composition is API-only.** The CLI's `release update` doesn't accept `--composition` (the field stores into `metadata.$.composition` via `json_set`, which the CLI hasn't surfaced). When you need to write composition:

```bash
curl -fsS -X PATCH "$RELEASES_API_URL/v1/releases/rel_…" \
  -H "Authorization: Bearer $RELEASES_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"composition":{"bugs":2,"features":1,"enhancements":3}}'
```

`-fsS` makes curl exit non-zero on 4xx/5xx and print the error body. Plain `-s` masks failures and lets a backfill loop look successful when every PATCH returned 500.

Pass `"composition": null` to record "AI ran, produced no counts" (distinct from clearing the key). The PATCH route also re-embeds the release vector when any of `content`/`title`/`summary`/`titleGenerated`/`titleShort` changes — that's a feature, not a side effect to avoid.

## Failure Modes to Watch For

- **Empty body** → `isEmptyContent(body)` is the gate. Skip the model and write the four fields as NULL. Don't let a sub-agent hallucinate content for an empty changelog entry.
- **Model returns malformed XML** → `parseReleaseContent` will return empty strings for missing tags; don't write empty strings (the API stores them as empty text, not NULL). Convert `""` → `null` before the PATCH.
- **Truncated output** (stop_reason `max_tokens`) → likely the `<composition>` block got cut off but `<title>`/`<title_short>`/`<summary>` came through. Write what you have; pass `composition: null` in the PATCH.
- **Title overflow** → the prompt's hard cap is 100 chars; sometimes the model exceeds it. Truncate at 100 with no ellipsis (the prompt forbids ellipses) or re-prompt that single row inline.
- **`isEmptyContent` says no but the body is pipeline boilerplate** → the BOILERPLATE_BODIES set is conservative; "Various bug fixes." passes it. If the model returns the in-prompt sentinel "Release notes do not describe the change." as the summary, treat that as the empty-body case and write NULLs anyway.

### Don't Confabulate Around Tool Failures

Real incidents have come from sub-agents quietly working around upstream errors:

- **Sub-agent's CLI write denied** (`Permission denied` on `releases admin release update`) → the agent should NOT retry with raw `curl` or invent a different write path. Return the structured payload to the parent; the parent writes.
- **`wrangler d1 execute` errors** → STOP and surface. Do not generate from a partial candidate set silently.
- **Provider API thoughts** inside a sub-agent ("let me just call Anthropic directly with `ANTHROPIC_API_KEY`") → no. The skill assumes the parent's inference is the inference. Reading `.env` is forbidden across this corpus. The only legitimate provider call is the parent's own Anthropic call (Mode A) or the Batches script (Mode C).
- **Out-of-skill data sources** ("let me also check the project blog for context") → no. The only input is the release row. If `content` is empty, the answer is NULLs, not enrichment.

## Composing With Other Skills

- **`parsing-changelogs`** is the upstream pipeline. If `content` looks structurally wrong (HTML chrome embedded, anchor IDs not stripped), the issue is in the source's parse step, not in this skill. Fix the source, refetch, then regenerate.
- **`maintaining-orgs`** dispatches per-org regen agents that run `regenerating-overviews`. Release content is a finer grain — it can be invoked inside a `maintaining-orgs` run as a follow-up step on the same org window, or independently. The two skills don't share state.
- **`scripts/generate-release-content.ts`** is the production backfill. This skill is its local-experiment sibling; the prompt and parse contract are shared via `packages/ai/src/release-content.ts`.
