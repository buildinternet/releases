# Self-published changelog — publishing releases.sh's own changelog on releases.sh

**Date:** 2026-06-10
**Status:** Phase 1 (seed) shipped & verified live 2026-06-10; org overview generated. Phase 2 (engine) tracked in [buildinternet/releases#1567](https://github.com/buildinternet/releases/issues/1567).

**Phase 1 outcome (2026-06-10):** Org `releases-sh` (name "Releases", domain `releases.sh`)
and push-only `agent` source `product-changelog` (`src_LNrMz-rrFa2OD27mBUfaT`) created in
prod; 37 daily rollups (May 1 – June 9, 2026; 125 bullets) upserted via `/batch`; avatar
set from the site mark. Note: the slugs `releases` and `changelog` are both **reserved** by
the API, so the org slug is `releases-sh` and the source slug is `product-changelog` (the
display names are still "Releases" / "Changelog"). Org overview generated against the
production prompt (`packages/ai/src/overview-content.ts`) and uploaded via
`admin overview update` — note the `admin overview batch` selector skips orgs with
`autoGenerateContent: false` (the default at creation), so single-org regen goes through
`update`, not `batch`.

## Summary

Releases.sh does not yet appear in its own registry (`lookup_domain releases.sh` → no
match), so the single most credible demo a changelog registry can offer — _its own_
changelog, indexed like everyone else's — doesn't exist. This design onboards
releases.sh as a first-class org in its own registry and feeds it a curated,
**daily-rolled-up** product changelog generated from merged PRs by our own AI stack,
gated by human review.

The work is staged:

- **Phase 1 — Seed the showcase (now, ~no code):** onboard the org + a push-only source
  and hand-curate a handful of recent daily rollups via `/batch`. Delivers a live, real,
  good-looking page immediately.
- **Phase 2 — The daily engine (the build):** two GitHub Actions that draft a daily
  rollup from merged PRs (AI-curated), open it as a PR for human approval, and publish
  the merged entry to `/batch`.

## Goals

- Occupy a publishing surface we already ship: the org page + AI overview + Atom feed +
  MCP + follows + digest + search. No new _reader_ code.
- Dogfood the real product loop — our **write** path (`/batch`) and our **AI
  summarization/classification** stack (`packages/ai`) — on our own content.
- Keep the changelog **low-noise**: a curated, rolled-up digest, never one entry per
  merged PR.
- Keep the canonical copy **durable and reviewable** — version-controlled in the repo,
  changed through PRs.

## Non-goals

- No new authoring UI inside the app. Authoring happens in git (markdown + PR review).
- No exhaustive backfill of all history in Phase 1 — just enough recent rollups to make
  the page feel alive.
- No fully-autonomous publishing in Phase 2 v1 — a human merges the daily PR. (Auto-merge
  for high-confidence days is a possible later iteration, explicitly deferred.)
- Not changing how the OSS CLI (`buildinternet/releases-cli`) does its own changesets-based
  release notes — that's a separate, already-working mechanism for the npm package.

## Constraints / context that shaped this

- **Velocity is high and mostly internal.** ~950 non-merge commits in 60 days (561 feat /
  286 fix / 124 chore / 70 refactor / 15 test / 12 perf in 90 days). The changelog must be
  a _curated slice_, not the git log. One-PR-one-entry would be unusable.
- **The monorepo (the platform) has no changelog today.** The CLI has one via changesets;
  the platform/web/MCP changelog is exactly what's missing.
- **The monorepo is private**, so a public `scrape`/`github` source cannot read its
  changelog. Canonical-in-repo therefore reaches the registry via an authenticated
  **push** (`/batch`) from CI, not via the poll-fetch adapters.
- **The release model already has a `rollup` type** (distinct from `feature`) — a daily
  digest entry maps onto it natively.

## Decisions

| #             | Decision                             | Choice                                                                              | Notes                                                                                                                                                           |
| ------------- | ------------------------------------ | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Role          | What is this for?                    | Staged: showcase now → canonical destination later                                  | Low risk to start, clear path to "primary."                                                                                                                     |
| Engine        | How do entries flow in?              | Canonical markdown in repo → CI push to `/batch` (Approach A)                       | Durable, PR-reviewed, welded to shipping; dogfoods the write path.                                                                                              |
| Cadence       | How are entries cut?                 | **Daily date rollups**, skip quiet days                                             | One `rollup` per active day; all-internal days produce nothing.                                                                                                 |
| Org modeling  | How do we model ourselves?           | A single org **Releases** (slug `releases`), one push-only source — no product      | Brand-first and simplest to understand; releases hang off one source. (Build Internet→Releases considered for cross-product future-proofing; chose simplicity.) |
| `url` / dedup | Stable key for `/batch` idempotency  | Synthetic on-site permalink per date, e.g. `https://releases.sh/updates/2026-06-10` | A small route resolves it; "view source" points at our own page (correct for a self-published changelog).                                                       |
| AI autonomy   | How much does AI publish on its own? | Draft-PR → human approve (v1)                                                       | Auto-merge for high-confidence days deferred.                                                                                                                   |

## Architecture

### Identity in the registry

Onboarded exactly like any third-party company, kept deliberately minimal:

- **Org** = Releases (slug `releases`), domain `releases.sh`, with an avatar. The org _is_
  the product — no separate product row.
- **Source** = a **push-only** source under the org: no `metadata.feedUrl` /
  `metadata.githubUrl`, excluded from the poll-fetch cron (nothing to scrape). It exists
  solely to own the published releases. Writes arrive via `/batch`.
- **Reading home** = the existing org page (timeline, AI overview, Atom, MCP, follows,
  digest, search). No reader code is written.

### Phase 1 — Seed the showcase (now, ~no code)

Use existing endpoints / the `managing-sources` + `local-ingest` tooling to:

1. Create the org (Releases) and the push-only source.
2. Hand-curate ~10–20 recent user-facing highlights into a handful of **backdated daily
   rollups** and upsert them via `/batch`.
3. Verify the page renders: timeline, overview, Atom, MCP, search.

This is production data-ops against the real registry — see "Operational / safety" below.
Output: a live, real page that proves the loop and gives Phase 2 something to extend.

### Phase 2 — The daily engine (the build)

Two GitHub Actions (the raw material — merged PRs — lives in GitHub):

**A. Draft (daily cron)**

1. Gather PRs merged to `main` since the last cut (by date / last-published rollup).
2. **Curate:** run each through `packages/ai` to drop non-user-facing changes. Strong
   prior from the conventional-commit type: `feat` / `fix` are candidates; `chore` /
   `test` / `refactor` / `docs` / `perf` are dropped by default. Title + body inform the
   final call.
3. **Compose:** group the survivors into **Added / Fixed / Changed** and rewrite each in
   _user_ language (e.g. `feat(follows): Bearer auth on /v1/me/*` → "Manage who you follow
   from the CLI and MCP").
4. Write `changelog/YYYY-MM-DD.md` and **open a PR**. Empty / all-internal days open
   nothing.

**B. Publish (on merge to `main` touching `changelog/`)**

1. Read the added/changed entry file(s).
2. POST to `/v1/releases/batch` as a `rollup` release under the push-only source, keyed on
   the per-date synthetic `url`. Idempotent — re-runs and post-merge edits converge.

Canonical lives in `changelog/` in the repo: diffable, revertible, reviewed. The human
gate is simply merging (or editing then merging) the daily PR.

### Data flow

```
merged PRs ──daily cron──▶ AI curate + group + rewrite ──▶ changelog/2026-06-10.md (PR)
                                                                │  human edits / merges
                                                                ▼
                                            on-merge Action ─▶ POST /v1/releases/batch (rollup)
                                                                │
                                                                ▼
                          releases.sh org page · Atom · MCP · digest · search
```

### Noise control (the core constraint), in three layers

1. **Batched** — at most one entry per day.
2. **AI-curated** — trivia (refactors, tests, chores, flag retirements) dropped before a
   human ever sees it.
3. **Human-gated** — you trim or kill the draft before it's public.

A PR never becomes an entry on its own.

## Entry format (illustrative)

```markdown
## June 10, 2026

Added

- Daily & weekly digest emails for orgs/products you follow
- Inline video cards (Loom, Wistia, YouTube) on release pages

Fixed

- Search now shows org avatars on product results
```

- One `## <date>` per file, mapped to one `rollup` release (title = the date).
- Sections limited to Added / Fixed / Changed; empty sections omitted.
- Body stored as the release body; the grouped markdown renders on the existing release
  page.

## Error handling / edge cases

- **Quiet day:** no user-facing survivors → draft Action opens no PR; publish Action no-ops.
- **Idempotency:** `/batch` dedups on `(source_id, url)`; the per-date synthetic `url`
  makes re-runs and post-merge edits update-in-place rather than duplicate.
- **AI misclassification:** caught by the human review gate; the conventional-commit prior
  bounds false-positives. Prompt is tuned against real history before trusting it.
- **Backfill / corrections:** editing a past `changelog/<date>.md` and merging re-pushes
  that date's entry (idempotent upsert), so corrections are a normal PR.
- **Cron never scrapes the self-source:** the source carries no fetch routing and is
  excluded from poll-fetch, so the steady-state ingest pipeline never clobbers
  push-published content.

## Testing

- **Phase 1:** manual verification that the org + source exist and the seeded rollups
  render across page, Atom, MCP, and search.
- **Phase 2:**
  - Unit-test the curation filter (conventional-commit classification + AI verdict shape)
    and the markdown→`/batch` payload mapping against fixtures.
  - Dry-run the draft Action against a recent date range and eyeball the produced markdown
    before enabling the cron.
  - Verify publish idempotency: push the same entry twice → one release, updated in place.

## Operational / safety

- **Phase 1 writes to the production registry.** Creating the org and seeding releases is
  an outward, not-trivially-reversible action; the org slug, the source, and the specific
  seeded entries are confirmed with the user before any prod write, and the drafted entries
  are reviewed before they go public.
- **Phase 2 publish Action needs a write-scoped credential** (`relk_`/`relu_` or root) in
  CI to call `/batch`. Stored as a GitHub Actions secret; scoped to `write`.

## Scope / sequencing

- **Phase 1** is light enough to execute directly (onboarding + seed via existing
  endpoints) once the specifics are confirmed — it does not need its own plan.
- **Phase 2** (the engine: two Actions + the AI curation/compose step + the publish
  mapping) is the real engineering and gets its own implementation plan.
- Ship Phase 1 first so the page is live while Phase 2 is built.

## Open questions deferred (not blocking)

- Exact prompt + model for the curate/compose step (reuse `packages/ai`; pick during
  Phase 2 planning).
- ~~Whether the per-date `url` resolves to a dedicated route or an anchor.~~ **Resolved
  2026-06-10:** shipped a branded `/updates` page (the public face of the `releases-sh` org)
  plus `/updates/[date]` permalinks; the 37 rollups' `url` was repointed from
  `/changelog/<date>` to `/updates/<date>`. Footer + sitemap updated. (Slug `updates` is free;
  only the singular `update` is reserved.)
- Auto-merge for high-confidence days (explicitly deferred from v1).
