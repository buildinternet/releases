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

Turn the one-time curated seed into a **self-feeding engine** so the changelog stays current with
zero routine manual curation — while staying low-noise (one rollup per active day, AI-curated,
human-gated; **never one entry per PR**).

The canonical artifact is a **single running `CHANGELOG.md`** at the repo root, date-sectioned and
newest-first. Two GitHub Actions drive it:

- **Draft** (daily cron): a Claude agent reads PRs merged since the last entry, drafts a new
  `## <date>` section, prepends it to `CHANGELOG.md`, and opens a PR.
- **Publish** (on merge): a deterministic bun script parses the date sections that changed and
  pushes them to the registry via `/batch`, then (re)generates their summary fields.

The human gate is merging (or editing then merging) the daily PR. Canonical lives in `CHANGELOG.md`:
one conventional file, diffable, revertible, reviewed.

## Why a single file (not N per-date files, not changesets)

- **One running `CHANGELOG.md`** is the conventional, expected artifact — greppable, readable
  top-to-bottom. Tools like changesets and towncrier keep _transient_ fragment files only to fold
  them into one permanent CHANGELOG and **delete** them; a pile of permanent per-date files is the
  worst of both (clutter + no single readable file).
- **Not literal changesets.** Changesets is built around **semver package releases** — it bumps a
  version and groups entries _by version_. This monorepo is an **unversioned, continuously-deployed
  service**: there's no version to bump or group by. The natural analog is a **date-sectioned**
  running CHANGELOG.md ("Keep a Changelog," keyed by date).
- **Authoring stays AI-from-PRs** (the Phase 2 premise): no per-PR changeset discipline. The
  registry still receives one dated `rollup` release per active day regardless of repo
  representation — only the canonical file shape changed from the earlier draft of this spec.

## Decisions

| #                  | Decision                                  | Choice                                                                                                      | Notes                                                                                                                                                                                                   |
| ------------------ | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical artifact | How is the changelog stored in-repo?      | **Single running `CHANGELOG.md`**, date-sectioned, newest-first                                             | One conventional file. New days prepend a `## <date>` section.                                                                                                                                          |
| Section key        | Version or date?                          | **Date** (`## June 10, 2026`)                                                                               | The platform is unversioned / continuously-deployed — no semver to group by.                                                                                                                            |
| Draft engine       | How is curation done?                     | **Claude agent in CI** (`claude-code-action`)                                                               | Reuses the wired `CLAUDE_CODE_OAUTH_TOKEN` (`.github/workflows/claude.yml`). Proven this session: an agent reading PRs/diffs produced high-quality rollups, and can drill into diffs for ambiguous PRs. |
| Publish engine     | How do entries reach prod?                | **Deterministic bun script, no AI**                                                                         | Parse changed sections → `/batch`; idempotent; unit-tested. AI judgment stays in the draft step; the production write path stays predictable.                                                           |
| Source of truth    | What feeds the draft?                     | **PRs merged to `main`** (`gh pr list`)                                                                     | Squash-merge PR titles/bodies are clean (`feat(x): … (#NNNN)`); conventional-commit type is the strong include/exclude prior.                                                                           |
| Cadence            | How are entries cut?                      | **Daily date rollups**, skip quiet days                                                                     | One `## <date>` section / `rollup` release per active day; all-internal days produce nothing.                                                                                                           |
| `url` / dedup      | Idempotency key                           | **`https://releases.sh/updates/<date>`**                                                                    | The `/updates/<date>` route already ships (Phase 1). The issue text still says `/changelog/<date>` — stale; use `/updates/<date>`.                                                                      |
| Body format        | Section shape                             | `**Added**` / `**Changed**` / `**Fixed**` bold sections, dash bullets, under a `## <Month D, YYYY>` heading | Matches the 62 live entries (the heading is the title; section bodies become the release `content`).                                                                                                    |
| Summaries          | `summary`/`title_short`/`title_generated` | Publish calls **`POST /v1/workflows/generate-content`** after `/batch`                                      | The push-only source never runs the ingest-time summarizer; `generate-content` (#1562) is the only write path for these fields.                                                                         |
| Corrections        | Editing a past section                    | Publish pushes with **`mode:"upsert-content"`** + scoped `regenerate`                                       | Default fill-don't-clobber would ignore body edits; upsert-content clobbers content idempotently, then a scoped regenerate refreshes the summary for the changed dates.                                 |
| Repo seed          | Should `CHANGELOG.md` start populated?    | **One-time bootstrap export** of the 62 live entries                                                        | Makes the repo the true canonical mirror, gives the draft agent in-repo voice examples, and makes the "latest section" watermark robust from day one.                                                   |
| AI autonomy        | How much publishes itself?                | **Draft-PR → human merge** (v1)                                                                             | Auto-merge for high-confidence days explicitly deferred.                                                                                                                                                |

## Architecture

```
daily cron ─▶ [Draft Action: claude-code-action]
                reads PRs merged since the latest section's date, drills into diffs when unsure,
                prepends one ## <date> section per active day to CHANGELOG.md, opens a PR
                                    │
                          human review / edit / merge        ◀── the only gate
                                    ▼
push to main touching CHANGELOG.md ─▶ [Publish Action: bun script, no AI]
                parse the added/modified ## <date> sections
                /batch (mode: upsert-content, idempotent on /updates/<date>)
                  └─▶ generate-content (regenerate the pushed dates)
                                    ▼
              releases-sh org page · Atom · MCP · digest · search
```

### Canonical file (`CHANGELOG.md`)

```markdown
# Changelog

The product changelog for releases.sh, published to its own registry. Drafted daily from merged
PRs and reviewed via PR. See docs/changelog-style.md for the voice + curation rules.

## June 9, 2026

**Added**

- …

**Changed**

- …

## June 8, 2026

**Added**

- …
```

- Newest section first, directly under the `# Changelog` preamble.
- One `## <Month D, YYYY>` heading per active day → one `rollup` release (title = the heading text,
  `publishedAt = <date>T12:00:00Z`, `url = /updates/<date>`).
- The section body (everything between this heading and the next `##`) becomes the release
  `content`, verbatim.

### Component 1 — Draft Action (`.github/workflows/changelog-draft.yml`)

**Trigger:** `schedule` (daily) + `workflow_dispatch` (manual / dry-run, with optional `since`/
`until` date inputs for rehearsal or a missed-window catch-up).

**Permissions:** `contents: write`, `pull-requests: write`, `id-token: write`.

**Concurrency / no-stacking:** a `concurrency: { group: changelog-draft }` guard plus a pre-step that
**skips if an open changelog-draft PR already exists** (`gh pr list --search "head:changelog/draft"`)
— never stack two unmerged draft PRs that both prepend to the same file (that would conflict).

**Window logic** (small shell/bun step, passed to the prompt):

- `SINCE` = (date of the **newest `## <date>` section** in `CHANGELOG.md`) + 1 day; if the file has
  no sections, **yesterday** (UTC).
- `UNTIL` = yesterday (UTC).
- **Hard cap:** if `UNTIL - SINCE > 7` days, clamp `SINCE = UNTIL - 7` and log the skipped older
  days — the daily cron never silently backfills history (that's the one-time bootstrap's job). A
  larger gap is caught up deliberately via `workflow_dispatch` with an explicit range.

**Agent step:** `anthropics/claude-code-action` in headless `prompt` mode. The prompt:

1. States `[SINCE, UNTIL]`; for each day, gather merged PRs via
   `gh pr list --search "merged:<day> base:main" --json number,title,body,mergedAt,labels`.
2. Reads **`docs/changelog-style.md`** first (audience, INCLUDE/EXCLUDE, conv-commit prior, format,
   voice) and treats the existing top sections of `CHANGELOG.md` as voice/density examples.
3. Inspects diffs (`gh pr diff` / `git show`) for any PR whose user-facing impact is unclear.
4. For each active day with user-facing survivors, **prepends** a `## <Month D, YYYY>` section
   (newest at the top, directly under the preamble). Quiet/all-internal day → no section.
5. If `CHANGELOG.md` changed, open ONE PR from a `changelog/draft-<UNTIL>` branch titled
   `changelog: <date>` (or a range) with a short body. If nothing changed, exit with no PR.

**Fallback:** if `claude-code-action` headless+PR-open is awkward for a cron context, implement the
same step as a bun script using `@anthropic-ai/claude-agent-sdk` (already a dependency) +
`gh pr create`. Identical prompt, style guide, and window logic. Decide during implementation.

### Component 2 — Publish Action (`.github/workflows/changelog-publish.yml`)

**Trigger:** `push` to `main` with `paths: ["CHANGELOG.md"]`. (Fires post-merge; GH secrets never
reach fork PRs, so the admin token is safe.)

**Permissions:** `contents: read`. Secret: `RELEASES_API_KEY` (admin-scoped `relk_`).

**Step:** `bun scripts/changelog/publish.ts`:

1. Diff `CHANGELOG.md` across the pushed range (`git diff <before>..<after> -- CHANGELOG.md`) and
   determine **which `## <date>` sections were added or modified** (a section is "changed" if any
   line within its span changed). This bounds the work to the day(s) that actually changed.
2. Parse those sections into releases via the pure mapping:
   - `date` ← heading (`Month D, YYYY` → ISO)
   - `title` ← the heading text
   - `url` ← `https://releases.sh/updates/<date>`
   - `publishedAt` ← `<date>T12:00:00Z`
   - `type` ← `"rollup"`
   - `content` ← the section body verbatim
3. `POST /v1/sources/src_LNrMz-rrFa2OD27mBUfaT/releases/batch` with
   `{ mode: "upsert-content", releases: [...] }` — inserts new days, clobbers edited bodies,
   idempotent on `(source_id, url)`.
4. Resolve the pushed dates to release IDs (`GET …/releases`, match `publishedAt` date), then call
   `POST /v1/workflows/generate-content` **scoped to those IDs**, splitting by change kind:
   **added** dates → `regenerate:false` (fill; only the new day's summary is missing); **modified**
   dates → `regenerate:true` (a correction must re-roll the summary). This is what makes a bootstrap
   merge a safe no-op: the exported sections already match live content (so `/batch` upsert-content
   changes nothing) and already have summaries (so fill finds nothing to do).
5. Log the result; non-zero exit on any HTTP error so a failed publish is visible in Actions.

The section-parse + section-change-detection is the **pure, unit-tested core** (no network), with a
thin network wrapper.

### Component 3 — Style guide (`docs/changelog-style.md`)

The durable, version-controlled curation rules used this session (so the engine's voice is
reviewable and improvable via PR):

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
- **Format:** a `## <Month D, YYYY>` heading, then `**Added**` / `**Changed**` / `**Fixed**` bold
  sections (in that order; omit empty), dash bullets, "Thing — what it does for you" phrasing.
- **Guardrails:** no PR numbers, no commit hashes, no internal file/function names, no
  conventional-commit prefixes, no competitor-named bug call-outs, never mention unshipped features.
- **Reference:** the existing top sections of `CHANGELOG.md` are the canonical voice/density
  examples.

### Component 4 — One-time bootstrap export (`scripts/changelog/export-existing.ts`)

Run once, by hand, to seed `CHANGELOG.md` from the 62 live rollups:

1. `GET /v1/sources/<src>/releases?limit=100`.
2. Sort newest-first; emit the `# Changelog` preamble, then one `## <title>` section per release
   with its `content` verbatim.
3. Commit. After this, `CHANGELOG.md` covers Mar 25 – Jun 9, the watermark logic has history, and
   the draft agent has in-repo examples. Not part of the recurring engine.

**Recommended:** land the bootstrap commit before the publish workflow exists (rollout step 1
precedes step 2). With the fill-for-added / regenerate-for-modified rule above, landing them
together is also safe — the exported sections match live content and summaries, so the triggered
publish run is a no-op (upsert-content sees no diff; fill finds nothing to generate). Sequencing
just keeps the first run obviously clean and avoids relying on that no-op behavior.

## File inventory

| Path                                      | Kind            | Purpose                                                                                |
| ----------------------------------------- | --------------- | -------------------------------------------------------------------------------------- |
| `CHANGELOG.md`                            | new (bootstrap) | The single canonical changelog; date-sectioned, newest-first.                          |
| `.github/workflows/changelog-draft.yml`   | new             | Daily draft cron + `workflow_dispatch`; runs the agent, opens the PR.                  |
| `.github/workflows/changelog-publish.yml` | new             | On-merge publish trigger; runs the publish script.                                     |
| `scripts/changelog/publish.ts`            | new             | Deterministic publish: changed sections → `/batch` upsert → `generate-content`.        |
| `scripts/changelog/publish.test.ts`       | new             | Unit tests for the pure core (section parse, section-change detection, field mapping). |
| `scripts/changelog/export-existing.ts`    | new             | One-time bootstrap export of the 62 live entries.                                      |
| `docs/changelog-style.md`                 | new             | The curation/voice/format guide the agent reads.                                       |

## Credentials & security

- **Draft:** reuses the existing `CLAUDE_CODE_OAUTH_TOKEN` secret. Cron/`workflow_dispatch` triggers
  only — no untrusted-comment surface like `claude.yml` has.
- **Publish:** a new `RELEASES_API_KEY` GH secret, an **admin-scoped `relk_`** token (admin because
  `generate-content` is under the admin-only `/v1/workflows/*` namespace; `/batch` alone needs only
  `write`). Contained: one workflow, private repo, post-merge `push` trigger (fork PRs never receive
  secrets). Mint via the scoped-token route; document rotation.
- **No auto-merge** in v1: a human always merges the draft PR, so nothing reaches prod un-reviewed.

## Testing

- **Unit (`publish.test.ts`):** the pure core against fixtures — section parse (heading→{title, url,
  publishedAt}, body capture), section-change detection from a `CHANGELOG.md` diff (added vs
  modified vs untouched), and multi-section pushes.
- **Draft dry-run:** `workflow_dispatch` the draft on a recent `since`/`until` → inspect the PR →
  tune `docs/changelog-style.md`. Repeat until curation reliably excludes internal work on a real
  week.
- **Publish idempotency:** merge a section → exactly one release; re-push the same section → one
  release, updated in place. Edit a past section → live body + summary update.

## Rollout sequence

1. Land the bootstrap export → `CHANGELOG.md` mirrors the 62 live entries.
2. Land `docs/changelog-style.md`, the publish script + tests, and both workflows (draft workflow
   shipped with only `workflow_dispatch` first — `schedule` disabled).
3. Add the `RELEASES_API_KEY` admin secret.
4. Dry-run the draft via `workflow_dispatch`; eyeball the PR; tune the style guide.
5. Test the publish path end-to-end (merge a dry-run draft section; verify the live entry + summary;
   re-push for idempotency).
6. Enable the daily `schedule` on the draft workflow.

## Edge cases / error handling

- **Quiet/all-internal day:** draft prepends nothing, opens no PR; publish never fires.
- **Missed run / catch-up:** window spans multiple days (multiple sections in one PR), hard-capped
  at 7; older gaps are a deliberate `workflow_dispatch` with an explicit range.
- **No stacked drafts:** the draft job skips if an open changelog-draft PR already exists, so two
  unmerged PRs never both prepend to `CHANGELOG.md` (avoids conflicts).
- **Idempotency & corrections:** `(source_id, url)` dedup + `mode:"upsert-content"` make re-runs and
  post-merge edits converge; a scoped `regenerate` refreshes the summary for changed dates.
- **Agent misclassification:** bounded by the conventional-commit prior and caught by the human
  merge gate; the style guide is tuned against real history before the cron is enabled.
- **Publish failure:** non-zero exit surfaces in Actions; re-running (or re-pushing) is safe
  (idempotent).
- **Cron never scrapes the self-source:** the source carries no fetch routing and is excluded from
  poll-fetch, so steady-state ingest never clobbers push-published content.

## Non-goals / deferred

- **Auto-merge** for high-confidence days (v1 is always human-merge).
- **Changeset-style or hybrid authoring** (human fragments per PR) — considered and declined for v1
  in favor of keeping authoring fully AI-from-PRs; revisit if AI fidelity proves insufficient.
- **A date-aware mode in the shared `parseChangelog`** (`packages/core`) — today it's version-keyed
  and would skip date headings, so the publish script carries its own small date-section parser. A
  general date-keyed mode in the core parser (useful for ingesting other unversioned services'
  changelogs) is a possible later upstreaming, out of scope here.
- **A new authoring UI** — authoring is git (markdown + PR review).
- **Changing the OSS CLI's changesets release notes** — separate, already-working.
- **Backfilling more history** — the Mar 25 → Jun 9 backfill is done; the engine is forward-only.

## Open questions (non-blocking)

- Exact cron time (UTC hour after the day closes and most merges land) — pick during implementation.
- `claude-code-action` headless+PR-open vs. the Agent-SDK bun fallback — validate the former first;
  fall back if needed. No design impact.
- Whether to later relax `generate-content` to accept a `write` token (avoiding the admin CI secret)
  — only if the admin scope becomes a concern; out of scope for v1.
