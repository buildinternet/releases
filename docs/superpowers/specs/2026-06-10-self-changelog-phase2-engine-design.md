# Self-changelog Phase 2 — the daily auto-drafted rollup engine

**Date:** 2026-06-10
**Ticket:** [buildinternet/releases#1567](https://github.com/buildinternet/releases/issues/1567)
**Status:** Design — ready for an implementation plan.
**Predecessor:** Phase 1 seed + full genesis backfill shipped live 2026-06-10. The `releases-sh`
org and push-only `agent` source `product-changelog` (`src_LNrMz-rrFa2OD27mBUfaT`) now hold **62
daily `rollup` releases, Mar 25 – Jun 9 2026**, all with generated `summary` / `title_short` /
`title_generated`. Background and Phase 1 design:
`docs/superpowers/specs/2026-06-10-self-published-changelog-design.md`.

## Summary

Turn the one-time hand-/agent-curated seed into a **self-feeding engine** so the changelog stays
current with zero routine manual curation — while staying low-noise (one rollup per active day,
AI-curated, human-gated; **never one entry per PR**).

Two GitHub Actions:

- **Draft** (daily cron): a Claude agent reads PRs merged since the last entry, drafts
  `changelog/<date>.md` per active day following a committed style guide, and opens a PR.
- **Publish** (on merge): a deterministic bun script pushes the merged entry to the registry via
  `/batch` and (re)generates its summary fields.

The human gate is simply merging (or editing then merging) the daily PR. Canonical lives in
`changelog/` in the repo: diffable, revertible, reviewed.

## Decisions

| #               | Decision                                  | Choice                                                                 | Notes                                                                                                                                                                                                                                                 |
| --------------- | ----------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Draft engine    | How is curation done?                     | **Claude agent in CI** (`claude-code-action`)                          | Reuses the wired `CLAUDE_CODE_OAUTH_TOKEN` (`.github/workflows/claude.yml`). Proven this session: subagents reading `git log`/diffs produced high-quality rollups. The agent can drill into diffs for ambiguous PRs — a single-shot classifier can't. |
| Publish engine  | How do entries reach prod?                | **Deterministic bun script, no AI**                                    | Mechanical markdown→`/batch` mapping; idempotent; unit-tested. AI judgment stays in the draft step; the production write path stays predictable.                                                                                                      |
| Source of truth | What feeds the draft?                     | **PRs merged to `main`** (`gh pr list`)                                | Squash-merge PR titles/bodies are clean (`feat(x): … (#NNNN)`); conventional-commit type is the strong include/exclude prior.                                                                                                                         |
| Cadence         | How are entries cut?                      | **Daily date rollups**, skip quiet days                                | One `rollup` per active day; all-internal days produce nothing.                                                                                                                                                                                       |
| `url` / dedup   | Idempotency key                           | **`https://releases.sh/updates/<date>`**                               | The `/updates/<date>` route already ships (Phase 1). The issue text still says `/changelog/<date>` — stale; use `/updates/<date>`.                                                                                                                    |
| Body format     | Entry shape                               | `**Added**` / `**Changed**` / `**Fixed**` bold sections, dash bullets  | Matches the 62 live entries (not the doc's plain-`Added` sketch). Date is the title; body carries no date heading.                                                                                                                                    |
| Summaries       | `summary`/`title_short`/`title_generated` | Publish calls **`POST /v1/workflows/generate-content`** after `/batch` | The push-only source never runs the ingest-time summarizer; `generate-content` (#1562) is the only write path for these fields.                                                                                                                       |
| Corrections     | Editing a past entry                      | Publish pushes with **`mode:"upsert-content"`** + `regenerate`         | Default fill-don't-clobber would ignore body edits; upsert-content clobbers content idempotently, then a scoped regenerate refreshes the summary.                                                                                                     |
| Repo seed       | Should `changelog/` start populated?      | **One-time bootstrap export** of the 62 live entries                   | Makes the repo the true canonical mirror, gives the draft agent in-repo voice examples, and makes the "newest file" watermark robust from day one.                                                                                                    |
| AI autonomy     | How much publishes itself?                | **Draft-PR → human merge** (v1)                                        | Auto-merge for high-confidence days explicitly deferred.                                                                                                                                                                                              |

## Architecture

```
daily cron ─▶ [Draft Action: claude-code-action]
                reads PRs merged since last entry, drills into diffs when unsure,
                writes changelog/<date>.md per active day, opens a PR
                                    │
                          human review / edit / merge        ◀── the only gate
                                    ▼
push to main touching changelog/** ─▶ [Publish Action: bun script, no AI]
                /batch (mode: upsert-content, idempotent on /updates/<date>)
                  └─▶ generate-content (regenerate the pushed dates)
                                    ▼
              releases-sh org page · Atom · MCP · digest · search
```

### Component 1 — Draft Action (`.github/workflows/changelog-draft.yml`)

**Trigger:** `schedule` (daily) + `workflow_dispatch` (manual / dry-run, with an optional
`since`/`until` date-range input for backfilling a missed window or rehearsal).

**Permissions:** `contents: write`, `pull-requests: write`, `id-token: write` (the agent creates a
branch, commits the file(s), and opens a PR).

**Window logic** (computed in a small shell/bun step, passed to the agent prompt):

- `SINCE` = (date of newest `changelog/*.md` in the repo) + 1 day, else **yesterday** (UTC) if the
  directory is empty.
- `UNTIL` = yesterday (UTC).
- **Hard cap:** if `UNTIL - SINCE > 7` days, clamp `SINCE = UNTIL - 7` and log that older days were
  skipped — the engine never silently backfills the whole history (that's the one-time bootstrap's
  job, not the daily cron's).

**Agent step:** `anthropics/claude-code-action` in headless `prompt` mode. The prompt:

1. States the window `[SINCE, UNTIL]` and instructs: for each day, gather PRs merged that day via
   `gh pr list --search "merged:<day> base:main" --json number,title,body,mergedAt,labels`.
2. Points at **`changelog/STYLE.md`** (read it first) for the audience, INCLUDE/EXCLUDE rules, the
   conventional-commit prior, the `**Added**/**Changed**/**Fixed**` format, and the voice.
3. Instructs it to `git show`/inspect diffs for any PR whose user-facing impact is unclear.
4. For each active day with user-facing survivors, write `changelog/<YYYY-MM-DD>.md` (body only —
   no date heading). Quiet/all-internal day → write nothing.
5. If any files were written, open ONE PR titled e.g. `changelog: <date>` (or `<SINCE>…<UNTIL>` for
   a multi-day catch-up) with a short body listing the days drafted. If nothing was written, exit
   cleanly with no PR.

**Fallback:** if `claude-code-action` headless+PR-open is awkward for a cron context, implement the
same step as a bun script using `@anthropic-ai/claude-agent-sdk` (already a dependency) +
`gh pr create`. Same prompt and style guide. Decide during implementation; the style guide and
window logic are identical either way.

### Component 2 — Publish Action (`.github/workflows/changelog-publish.yml`)

**Trigger:** `push` to `main` with `paths: ["changelog/**.md"]`. (Fires post-merge; GH secrets are
never exposed to fork PRs, so the admin token is safe.)

**Permissions:** `contents: read`. Secret: `RELEASES_API_KEY` (admin-scoped `relk_`).

**Step:** `bun scripts/changelog/publish.ts`:

1. Determine which `changelog/<date>.md` files were added or modified in the pushed commits
   (`git diff --name-status <before>..<after>`). **Process only files matching
   `changelog/<YYYY-MM-DD>.md`** — `STYLE.md`, `README.md`, and any other non-date file under
   `changelog/` are ignored, so editing the style guide never triggers a publish.
2. For each, build the release via the pure mapping function:
   - `date` ← filename (`YYYY-MM-DD`)
   - `title` ← `"Month D, YYYY"` (no leading zero)
   - `url` ← `https://releases.sh/updates/<date>`
   - `publishedAt` ← `<date>T12:00:00Z`
   - `type` ← `"rollup"`
   - `content` ← file body verbatim
3. `POST /v1/sources/src_LNrMz-rrFa2OD27mBUfaT/releases/batch` with
   `{ mode: "upsert-content", releases: [...] }` — inserts new days, clobbers edited bodies,
   idempotent on `(source_id, url)`.
4. Resolve the just-pushed dates to release IDs (`GET …/releases`, match `publishedAt` date), then
   `POST /v1/workflows/generate-content { sourceId, releaseIds:[…], regenerate:true, dryRun:false }`
   to (re)fill `summary`/`title_short`/`title_generated` for exactly those days.
5. Log the result; non-zero exit on any HTTP error so a failed publish is visible in Actions.

### Component 3 — Style guide (`changelog/STYLE.md`)

The durable, version-controlled encoding of the curation rules used this session (so the engine's
voice is reviewable and improvable via PR). Contents:

- **Audience:** developers and AI agents who use releases.sh (CLI, web, REST API, MCP, search,
  onboarding).
- **INCLUDE:** new CLI commands/flags, MCP tools, web features/pages, public API endpoints, search
  capabilities, new source-type/adapter support, org/product features, user-felt fixes, UX/perf
  users notice.
- **EXCLUDE:** internal refactors, tests, CI/build/tooling, dependency bumps, schema migrations
  (unless they enable a user feature — then describe the feature), logging, code cleanup,
  non-user-facing docs, anything unreleased/flag-gated not actually shipped.
- **Conventional-commit prior:** `feat`/`fix` are candidates; `chore`/`test`/`refactor`/`docs`/
  `perf` dropped by default; title + body + diff inform the final call.
- **Format:** `**Added**` / `**Changed**` / `**Fixed**` bold headers (in that order; omit empty
  sections), dash bullets, "Thing — what it does for you" phrasing.
- **Guardrails:** no PR numbers, no commit hashes, no internal file/function names, no
  conventional-commit prefixes, no competitor-named bug call-outs, never mention unshipped features.
- **Reference:** the live `releases-sh` entries are the canonical examples of voice and density.

### Component 4 — One-time bootstrap export (`scripts/changelog/export-existing.ts`)

Run once, by hand, to mirror the 62 live rollups into the repo:

1. `GET /v1/sources/<src>/releases?limit=100`.
2. For each, write `changelog/<publishedAt-date>.md` with the release `content` verbatim.
3. Commit. After this, `changelog/` holds Mar 25 – Jun 9, the watermark logic has history, and the
   draft agent has in-repo examples. Not part of the recurring engine.

**Land the bootstrap commit _before_ the publish workflow exists** (rollout step 1 precedes step
2). Otherwise the 62-file commit would trigger the publish workflow and re-push + `regenerate` all
62 live entries — wasteful and liable to re-introduce summarizer version artifacts on entries that
are currently clean.

## File inventory

| Path                                      | Kind           | Purpose                                                                                             |
| ----------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------- |
| `.github/workflows/changelog-draft.yml`   | new            | Daily draft cron + `workflow_dispatch`; runs the agent, opens the PR.                               |
| `.github/workflows/changelog-publish.yml` | new            | On-merge publish trigger; runs the publish script.                                                  |
| `scripts/changelog/publish.ts`            | new            | Deterministic publish: changed files → `/batch` upsert → `generate-content`.                        |
| `scripts/changelog/publish.test.ts`       | new            | Unit tests for the pure mapping (filename→fields, body passthrough, multi-file, added-vs-modified). |
| `scripts/changelog/export-existing.ts`    | new            | One-time bootstrap export of the 62 live entries.                                                   |
| `changelog/STYLE.md`                      | new            | The curation/voice/format guide the agent reads.                                                    |
| `changelog/README.md`                     | new (optional) | One paragraph explaining the dir + the engine.                                                      |
| `changelog/<date>.md`                     | generated      | The entries (62 from bootstrap; one/active-day thereafter).                                         |

## Credentials & security

- **Draft:** reuses the existing `CLAUDE_CODE_OAUTH_TOKEN` secret. Cron/`workflow_dispatch` triggers
  only — no untrusted-comment surface like `claude.yml` has.
- **Publish:** a new `RELEASES_API_KEY` GH secret, an **admin-scoped `relk_`** token (admin because
  `generate-content` is under the admin-only `/v1/workflows/*` namespace; `/batch` alone needs only
  `write`). Contained: one workflow, private repo, post-merge `push` trigger (fork PRs never receive
  secrets). Mint via the scoped-token route; document rotation.
- **No auto-merge** in v1: a human always merges the draft PR, so nothing reaches prod un-reviewed.

## Testing

- **Unit (`publish.test.ts`):** the pure mapping function against fixtures — filename→{title, url,
  publishedAt}, body passthrough, multiple files in one push, and added-vs-modified date detection.
- **Draft dry-run:** `workflow_dispatch` the draft on a recent `since`/`until` → inspect the opened
  PR → tune `STYLE.md`. Repeat until the curation reliably excludes internal work on a real week.
- **Publish idempotency:** merge an entry → exactly one release; re-push the same file → one release,
  updated in place (no duplicate). Edit a past file → live body + summary update.

## Rollout sequence

1. Land the bootstrap export → `changelog/` mirrors the 62 live entries.
2. Land `changelog/STYLE.md`, the publish script + tests, and both workflows (cron **disabled** —
   ship the draft workflow with only `workflow_dispatch` first).
3. Add the `RELEASES_API_KEY` admin secret.
4. Dry-run the draft via `workflow_dispatch`; eyeball; tune `STYLE.md`.
5. Test the publish path end-to-end (merge a dry-run draft; verify the live entry + summary;
   re-push for idempotency).
6. Enable the daily `schedule` on the draft workflow.

## Edge cases / error handling

- **Quiet/all-internal day:** draft writes no file, opens no PR; publish never fires.
- **Missed run / catch-up:** window spans multiple days (one file each), hard-capped at 7; older
  gaps are a manual `workflow_dispatch` with an explicit range.
- **Idempotency & corrections:** `(source_id, url)` dedup + `mode:"upsert-content"` make re-runs and
  post-merge edits converge; a scoped `regenerate` refreshes the summary for edited days.
- **Agent misclassification:** bounded by the conventional-commit prior and caught by the human
  merge gate; `STYLE.md` is tuned against real history before the cron is enabled.
- **Publish failure:** non-zero exit surfaces in Actions; re-running the workflow (or re-pushing) is
  safe (idempotent).
- **Cron never scrapes the self-source:** the source carries no fetch routing and is excluded from
  poll-fetch, so steady-state ingest never clobbers push-published content.

## Non-goals / deferred

- **Auto-merge** for high-confidence days (v1 is always human-merge).
- **A new authoring UI** — authoring is git (markdown + PR review).
- **Changing the OSS CLI's changesets release notes** — separate, already-working.
- **Backfilling more history** — the Mar 25 → Jun 9 backfill is done; the engine is forward-only.

## Open questions (non-blocking)

- Exact cron time (UTC hour after the day closes and most merges land) — pick during implementation.
- `claude-code-action` headless+PR-open vs. the Agent-SDK bun fallback — validate the former first;
  fall back if needed. No design impact.
- Whether to later relax `generate-content` to accept a `write` token (avoiding the admin CI secret)
  — only if the admin scope becomes a concern; out of scope for v1.
