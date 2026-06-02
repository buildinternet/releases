---
name: local-ingest
description: Onboard or backfill a company's changelog locally in Claude Code by fetching pages and extracting releases with the agent itself (and parallel sub-agents), then writing through the batch-upsert endpoint — no remote managed-agent session, no extraction inference billing. Use when you want to onboard a source without dispatching the MA, avoid the coordinator-Sonnet + worker-Haiku extraction loop, or recover from a remote fetch that burned tokens and wrote zero releases. Includes a mandatory robots.txt / Content-Signal opt-out gate.
---

# Local Ingest

Onboard a changelog **without dispatching the remote managed agent (MA).** The MA path (`releases admin source fetch` → `POST /v1/workflows/update` → discovery worker) spins up a coordinator (Sonnet 4.6) plus a worker (Haiku 4.5) and bills inference for the body→records extraction — even when it writes zero releases. A local Claude Code agent is already a capable model with web-fetch + file tools, so it can do the per-page extraction inline (folded into the session you're already in) and only needs a deterministic write path.

**Core principle: the agent is the extractor.** You fetch, you parse, you structure the records, and you POST them to the batch endpoint, which does a plain idempotent upsert with **no AI on insert**. The remote extraction loop never runs.

**Local Claude Code only.** This skill uses the `Agent` tool for sub-agent fan-out and assumes a persistent local filesystem and the CLI's `RELEASES_API_*` env. It sits alongside `seeding-playbooks` as a local-only operator skill — it is **not** deployed to the managed-agent fleet.

## Cost contract

State this explicitly to the operator before a large run, and honor it:

- **Spends:** your agent's own tokens for fetch + extract, plus any sub-agents you fan out (your choice of model — `sonnet` for quality, `haiku` for bulk).
- **Does NOT spend:** no MA coordinator-Sonnet, no Haiku worker loop, no remote `web_fetch` extraction. `POST /v1/workflows/update` is **never called**.
- **The batch endpoint runs no AI on insert** — no summarization, no marketing classifier, no feed enrichment. It does an `insert` plus a fire-and-forget vector embed (`waitUntil`). The AI fields (`title_generated` / `title_short` / `summary`) are intentionally left empty; see _Manual enrichment_ below for the deliberate follow-up paths.

The negative signal that confirms no MA ran: in Axiom `releases-cloudflare-logs` there is **no** `POST .../fetch?sessionId=ma-…` and **no** `extract-deps-worker` event for the source.

## When to use

- Onboarding a new source (or backfilling an existing one) interactively in Claude Code and you want to skip the remote MA cost.
- A remote fetch burned a full extraction loop and wrote **0 releases** (the Conductor / large-body / `max_tokens` failure mode) — extracting inline sidesteps the loop entirely.
- The page is fetchable by your own web tools (the refusal below is a policy gate, not a fetch limit).

**When NOT to use:**

- **You're in a managed-agent session.** This is local-only (Agent-tool fan-out + local filesystem + CLI env). MA sessions should keep using the normal fetch path.
- **The source has a clean, content-rich feed.** Just add it (`managing-sources`) and let the cron pipeline fetch it. Local-ingest is for cases where the agent doing the extraction inline is the right tool, not a replacement for feed/GitHub adapters.
- **The publisher opts out** (preflight refuses — see Step 1).

## Workflow

### Step 1 — Preflight (mandatory safety gate)

Run the opt-out check before fetching or writing **anything**:

```bash
bun src/agent/skills/local-ingest/preflight.ts <url> --json
```

It fetches `robots.txt` (following apex→www redirects), parses the Cloudflare **Content Signals** policy, and gates on exit code:

| Exit | Verdict   | Action                                                                                                         |
| ---- | --------- | -------------------------------------------------------------------------------------------------------------- |
| `0`  | `proceed` | Permissive or absent — continue.                                                                               |
| `1`  | `refuse`  | `ai-input=no` or `ai-train=no` declared. **STOP. Surface to the user.** Do not fetch or write.                 |
| `2`  | `unknown` | Couldn't fetch/parse robots.txt. Retry once; if still unknown, **surface to the user** — don't assume proceed. |

**This is the Conductor lesson.** `conductor.build` serves `Content-Signal: ai-train=no, search=yes, ai-input=no` — its org/source already sits paused in the registry for exactly this reason (`releases admin playbook conductor`). A local onboard must not silently spend tokens or ingest content against a publisher opt-out. **`conductor.build` must be refused** — it is the regression target for this gate.

The refusal is a **policy** choice, not a technical limitation: `web_fetch` and CF Browser Rendering can still retrieve these pages (only Cloudflare's `/crawl` endpoint hard-enforced the signal for Conductor). Honor the opt-out anyway. Override **only** with explicit publisher permission documented by the operator — there is no silent bypass.

The preflight also prints any `Sitemap:` URLs from robots.txt — keep them for Step 3.

### Step 2 — Resolve target

Ensure the org and source exist before writing — releases attach to a `source_id`. Defer to **`managing-sources`** for create/naming/primary rules and to **`finding-changelogs`** for whether a structured feed exists (if it does, prefer the normal pipeline). Then:

- Read the org playbook for parse hints: `releases admin playbook <org>` (see `managing-sources` → Playbooks).
- Capture the **`sourceSlug`** and the **`src_…` id** from the created/resolved row — you need one of them for the batch URL.

If the source is brand-new, create it (e.g. `releases admin source create "<name>" --url <url> --org <org> [--primary]`) but **do not trigger a fetch** — that would dispatch the MA you're trying to avoid.

### Step 3 — Map pages

Classify the page shape (`releases admin discovery evaluate <url> --json` reports `pageStructure: single-page | index | unknown`):

- **Single-page changelog** → one fetch in Step 4.
- **Index → detail** → enumerate the per-release URLs. Prefer `/sitemap.xml` (the preflight surfaced it) filtered to the changelog path; otherwise parse the index HTML for per-release links.

Cap to a recent window (default **~25–50** most-recent releases) and **log what you skipped** — never silently truncate. Re-runs are idempotent, so a deeper backfill later just adds rows.

### Step 4 — Fetch + extract

Reuse the **`parsing-changelogs`** conventions for type/version/date/media (see _Parity_ below).

- **A few pages:** fetch and extract inline in this agent.
- **Many pages:** fan out parallel sub-agents — one URL-slice each, each returning records in the batch schema. Use the `Agent`-tool dispatch pattern from **`seeding-playbooks`** (and **superpowers:dispatching-parallel-agents** for the fan-out discipline). Do **not** fetch release URLs in the parent agent — delegate to keep the parent's context clean.
- **Parent-saves caveat:** sub-agents may be blocked from making the batch write (permission limits). Plan for it — have each sub-agent **return** its records in its result, and let the parent (you) do the writes in Step 5. Same pattern `seeding-playbooks` uses for note-saving.

Each record must match the batch schema (see Step 5) and the parity rules.

**Optional — deterministic extraction (Approach A, monorepo only):** instead of extracting by hand you can call the production extract libs in `packages/adapters/src/extract/` — `extractFromBody`, `extractWithTools`, `runDirectFetchExtraction`. `ExtractDeps.cloudflare` is nullable and `repo` can be a noop, so they run with just an Anthropic key (proof: `scripts/smoke-toolloop.ts`). This trades agent tokens for direct Anthropic-API tokens but reproduces the production tool-loop exactly. These packages are `private: true` — reachable from the monorepo only, never the thin CLI. The default remains Approach B (the agent is the extractor).

### Step 5 — Write (batch upsert)

POST records to the batch endpoint in chunks (~50/request keeps requests bounded; the handler does the D1 bind-limit chunking server-side):

```bash
# Use the org-scoped path. The bare /v1/sources/:slug form accepts ONLY a typed
# `src_…` id — a human slug there returns 400 bare_slug_rejected (slugs are
# org-scoped, #690). With a typed id the bare form also works:
#   POST $RELEASES_API_URL/v1/orgs/<orgSlug>/sources/<sourceSlug>/releases/batch
#   POST $RELEASES_API_URL/v1/sources/<src_…>/releases/batch
curl -sS -X POST "$RELEASES_API_URL/v1/orgs/<orgSlug>/sources/<sourceSlug>/releases/batch" \
  -H "Authorization: Bearer $RELEASES_API_KEY" \
  -H "Content-Type: application/json" \
  -d @chunk.json   # { "releases": [ … ] }
```

Per-release fields (the real accepted shape — `workers/api/src/routes/sources.ts`, `postReleasesBatchHandler`):

```jsonc
{
  "version": "1.4.0", // optional; omit/null for date-headed or blog sources
  "title": "Dark mode", // required
  "content": "Markdown body…", // required
  "url": "https://…/changelog/dark-mode", // optional but ALWAYS populate — it's the dedup key
  "contentHash": "…", // optional
  "publishedAt": "2026-05-30", // optional; ISO-8601 (see Parity)
  "media": "https://…/shot.png", // optional
  "type": "feature", // optional; "feature" | "rollup"
  "prerelease": false, // optional
}
```

- **Idempotent.** Upserts on `UNIQUE(source_id, url)`, backfilling empty content/media on collision. Safe to re-run and to page — same `url` updates rather than duplicates.
- **Auth.** Requires `write` scope; the static `RELEASES_API_KEY` (root) satisfies it. `.env` autoloads `RELEASES_API_URL` + `RELEASES_API_KEY` in this repo.
- **No AI on insert** (see Cost contract).

Chunking helper (reads a `records.json` array, posts in batches of 50):

```bash
bun -e '
const orgSlug = process.argv[1], sourceSlug = process.argv[2], file = process.argv[3];
const all = JSON.parse(await Bun.file(file).text());
const base = process.env.RELEASES_API_URL, key = process.env.RELEASES_API_KEY;
for (let i = 0; i < all.length; i += 50) {
  const releases = all.slice(i, i + 50);
  const res = await fetch(`${base}/v1/orgs/${orgSlug}/sources/${sourceSlug}/releases/batch`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ releases }),
  });
  console.log(`chunk ${i / 50}: ${res.status} ${(await res.text()).slice(0, 200)}`);
}
' <orgSlug> <sourceSlug> records.json
```

### Step 6 — Validate

```bash
releases tail <slug> --json   # or: get_latest_releases (typed tool)
```

Confirm releases have non-empty **titles, dates, and content**. If results are thin (empty content, missing dates), fix the extraction and **re-run** — the upsert is idempotent, so backfilling content onto existing rows is safe.

### Step 7 — Playbook note

Record how this source was ingested so future agents don't re-derive it. Via `manage_playbook` (action `update_notes`) or `releases admin playbook <org> --notes-file -`. Note that the source was **locally ingested** (not on the cron path yet), its observed cadence, and any extraction quirks. Follow the `managing-sources` playbook-authoring rubric (imperative voice, keep-test, `### Fetch instructions` / `### Traps` / `### Coverage`). Don't restate metadata the header already carries.

## Parity requirements

Local output must match production shape so the source can later be picked up by the normal pipeline with no cleanup:

| Axis          | Rule                                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`        | `feature` vs `rollup` per **`parsing-changelogs`** → _Classifying Rollups_. Leave unset/`feature` by default.                                                 |
| `version`     | Real version string, or omit. **Pre-clean `<UNKNOWN>` / `n/a` placeholders** — the batch path does not strip them (the single-insert path does, server-side). |
| `publishedAt` | ISO-8601. Approximate from month/quarter/year headings rather than omit (`parsing-changelogs` → _Dates_): month → first of month, etc.                        |
| `media`       | Unwrap `_next/image` / Vercel optimizer wrappers before storing — use `normalizeMediaUrl` from `packages/rendering/src/media-url.ts`.                         |
| `url`         | **Always populate.** Dedup relies on a stable per-release `url`; without it the upsert can't collapse re-runs.                                                |

## Manual enrichment (out of scope for `/batch`, but available)

The batch path intentionally omits `title_generated` / `title_short` / `summary` and org overviews. When an operator wants them, set them deliberately, case by case:

- **Per-release override:** `PATCH /v1/releases/:id` accepts `summary`, `titleGenerated`, `titleShort`, `composition`, `version`, … and re-embeds when content/title/AI-fields change.
- **At insert time (alternative to `/batch`):** the single-release insert `POST /v1/sources/:slug/releases` accepts `summary?` / `titleGenerated?` / `titleShort?` — use this path instead of `/batch` when you want enrichment set in the same write. It also strips `<UNKNOWN>`/`n/a` versions server-side.
- **Bulk AI enrichment after the fact:** `bun scripts/generate-release-content.ts --orgs=<slug>`.

## Common mistakes

- **Skipping the preflight.** It's the first step for a reason — silently ingesting an opt-out source is the exact failure this skill exists to prevent. `conductor.build` must be refused.
- **Silent truncation.** Capping the window is fine; not telling the user what you skipped is not.
- **Missing `url`.** Breaks idempotency — re-runs duplicate instead of upserting.
- **Triggering a fetch on the new source.** `releases admin source fetch` / `manage_source` action `fetch` dispatches the MA — the cost you're avoiding. Create the source, then write via `/batch`.
- **Fetching detail pages in the parent agent during fan-out.** Delegate to sub-agents; keep the parent context clean.
- **Using this for a clean feed source.** Add it and let cron fetch — don't hand-extract what the feed adapter handles for free.
- **Running it in a managed-agent session.** Local Claude Code only.

## Related skills

- **`finding-changelogs`** — is there a feed/GitHub source that makes local-ingest unnecessary? Page-structure evaluation.
- **`managing-sources`** — create org/source, naming, primary, playbook authoring.
- **`parsing-changelogs`** — the extraction conventions you must match (type, dates, rollups).
- **`seeding-playbooks`** — the parallel `Agent`-tool dispatch + parent-saves pattern reused in Step 4.
- **superpowers:dispatching-parallel-agents** — fan-out discipline for the many-pages case.
