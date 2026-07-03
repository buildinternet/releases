# Implementation Plans

Two `improve`-skill runs live in this directory. Numbering is monotonic across
runs. Each executor: read the plan fully before starting, honor its STOP
conditions, and update your row when done.

> Note on location: this repo's documented convention puts local design specs in
> `.context/` (gitignored, ticket-ID-prefixed). These are placed under `plans/`
> instead so they're shareable/reviewable as a set; move or mirror into
> `.context/` if you prefer the local convention.

## Run 2 — full-repo audit, 2026-07-02, against commit `3238d540`

Standard-effort audit across all nine playbook categories (4 parallel
subagents: correctness, security, perf+tests, debt/deps/DX/docs; direction
audited directly). Session was non-interactive, so per the skill's default the
top findings by leverage were planned without a selection round. Security came
back clean (zero critical/high; constant-time comparisons, scope enforcement,
prompt-tag escaping on ingested content all verified present).

### Execution order & status

| Plan | Title                                                        | Priority | Effort | Depends on | Status |
| ---- | ------------------------------------------------------------ | -------- | ------ | ---------- | ------ |
| 004  | Surface swallowed write failures on the ingest path          | P1       | S      | —          | TODO   |
| 005  | Characterization tests for the ingest critical path (#1652)  | P1       | L      | —          | TODO   |
| 006  | Tests for the web admin server actions                       | P2       | M      | —          | TODO   |
| 007  | Surface the breaking-change field: read routes + web (#1710) | P1       | M      | —          | TODO   |

Status values: TODO | IN PROGRESS | DONE | BLOCKED (reason) | REJECTED (reason)

Recommended order: **004 first** (small, and 005's backoff-path tests then
guard its touched lines), **007 in parallel** (independent surface), then
**005**, then **006**.

### Dependency notes

- 004 and 005 touch overlapping behavior (the poll-fetch error-backoff
  writes): land 004 before 005 so the characterization tests pin the
  instrumented code, or run them on independent branches and rebase 005.
- 005 is the explicit prerequisite for the deferred `sources.ts` (3.9K LOC) /
  `orgs.ts` (2.3K LOC) god-module decomposition — that split is a valid
  finding but is NOT planned in this run; do not start it before 005 lands.
- 007 deliberately covers only checkboxes 1–2 of issue #1710. The webhook
  `breaking` filter (checkbox 3) needs its own subscription-storage design
  pass; #1711 (historical backfill) is cost-gated and operator-owned.

### Findings considered and rejected (2026-07-02 — so nobody re-audits them)

Refuted on verification (subagent claims that didn't survive reading the code):

- _`@cloudflare/sandbox` is an unused devDependency_: refuted —
  `workers/discovery/src/index.ts:17` exports `Sandbox` from it, and the root
  copy is what lets root-cwd `bun test workers/discovery` resolve it.
- _Sequential OG-image fetches should be parallelized_: refuted — the second
  fetch depends on the first's result (`release.org.slug`), and OG routes have
  `revalidate = 86400`.
- _Web/API packages missing `"private": true`_: refuted — all `@releases/*`
  packages have it; `core`/`api-types` are deliberately published.
- _OrgActor/SourceActor DO tests are shallow (no 429/503/kill-switch cases)_:
  refuted — `workers/api/test/org-actor.test.ts` covers exactly those branches.
- _Best-effort catches in `auth/index.ts` are silent-failure bugs_: refuted —
  commented by design ("Best-effort; never blocks"), one logs once by design.

Rejected as by-design or not worth doing:

- _Correlated `org_accounts` github-handle subquery is an N+1_: rejected — it
  executes in-process inside one D1/SQLite statement, was indexed in #1803,
  and is LIMIT-bounded. Profile before ever touching it.
- _Feature flags fully rolled out but still branching_ (`extractToolLoopEnabled`,
  `openrouterEnabled`): rejected — deliberate kill switches; the toolloop
  per-source rollout is tracked in #1653, not a dead branch.
- _CLAUDE.md is a bare `@AGENTS.md` pointer_: rejected — that is the idiomatic
  Claude Code import mechanism.
- _No one-command verification baseline_: rejected — `bun run test` is the one
  command; the three-process split inside it is documented, deliberate mock
  isolation.
- _Hono transitive version skew (4.12.14 via MCP SDK vs 4.12.26 root)_:
  rejected — patch-level, bun resolves it; noise.
- _Pagination/validation route-wrapper abstraction_: rejected — helpers are
  already centralized in `lib/pagination.ts`; a wrapper is premature.
- _Broad web server-component test harness_: not planned — L effort with
  over-mocking risk; plan 006 covers the highest-risk slice (admin actions)
  instead.
- _Catch sites in `feed.ts` / `firecrawl.ts` / `changelog.ts` /
  `admin-emails.ts` / `feed-cache.ts`_: rejected — documented-intentional
  best-effort or handled fallbacks (verified per-site); only the poll-fetch /
  search / org-actor sites made plan 004.

Valid but deferred (not planned this run):

- `sources.ts` / `orgs.ts` decomposition — L effort, MED risk; blocked on 005.
- Vestigial `"packageManager": "pnpm@…"` in root `package.json` (repo is Bun;
  no CI/corepack usage found) — one-line hygiene, fix opportunistically in any
  root-manifest PR rather than as a plan.
- `workers/discovery` swallowed-error sweep — same pattern as plan 004, not
  audited this pass.

Direction options surfaced but left to existing issues (already well-tracked):
#1698 (GitHub App PR bot — handler stubs already in `routes/github.ts`, needs
its own design pass per Run 1's note), #1678 (MCP webhook management tools),
#1653 (extract-toolloop per-source rollout), #1711 (breaking backfill).

---

## Run 1 — agent-native growth push, 2026-06-20, against commit `8f811cb5`

Design-spike plans for the load-bearing items of the agent-native growth
pivot (umbrella issue #1701, strategic source #1601). Each plan adds the
executor-ready _how_ on top of the product _what/why_ already in its GitHub
issue. Read the linked issue first, then the plan.

### Execution order & status

| Plan | Title                                          | Issue | Priority | Effort | Depends on | Status                                                                  |
| ---- | ---------------------------------------------- | ----- | -------- | ------ | ---------- | ----------------------------------------------------------------------- |
| 001  | Structured breaking-change + migration field   | #1696 | P1       | M      | —          | DONE (#1703 merged)                                                     |
| 002  | Upgrade intelligence Phase 1 — `whats_changed` | #1697 | P1       | M      | 001 (soft) | DONE (merged — route live at `workers/api/src/routes/whats-changed.ts`) |
| 003  | Agent/API consumption instrumentation          | #1700 | P1       | S–M    | —          | DONE (#1704 merged)                                                     |

### 001 — as built (branch `advisor/001-breaking-change-field`)

Two deviations from the plan, both tightening scope per operator steer:

- **Qualifying-kinds gate (which releases get classified).** The live ingest
  pass classifies only developer-facing source kinds — `sdk`, `tool`,
  `platform`, `integration` (`BREAKING_CLASSIFY_KINDS` /
  `qualifiesForBreakingClassification` in `@buildinternet/releases-core/kinds`).
  `mobile` (consumer apps), `docs`, `desktop`, and kind-less rows stay
  `breaking: "unknown"` and spend no classifier call. Widen the set there if the
  editorial scope changes.
- **No backfill; live path only.** Classification is wired into
  `generateContentForReleases` (the poll-fetch live path) only — NOT the batch
  backfill (`batch-summarize.ts` / `scripts/generate-release-content.ts`).
  History stays `unknown` until a separate, cost-estimated batch run populates
  it. The ~40K-row backfill remains the STOP-condition deferral.

Shape: **folded into the existing `summarizeRelease` call (#1696, option 1)** —
NOT a separate model request (operator steer: don't make a second AI call). The
summarize `SYSTEM_PROMPT` already scans the body for breaking changes to write
the title/summary (its `priority_order` ranks them #1), so the call now also
emits `<breaking>` + `<migration>` tags and `parseReleaseContent` returns
`breaking`/`migrationNotes`. The verdict also **weighs the SemVer signal** (a
major-version bump / `BREAKING CHANGE` / `!` → lean `major`; a patch → lean
`none`; pre-1.0 judged from the body; explicit body content overrides) — the
clearest indicator for GitHub/npm packages. Fail-open: `"unknown"` default, the
parser maps any unrecognized verdict to `unknown`, and the empty-body
short-circuit returns `unknown` with no model call.

The kind gate is applied at the **persist** site in `generateContentForReleases`
(the model classifies every release, but only developer-facing kinds store a
non-`unknown` value). MAX_OUTPUT_TOKENS bumped 280→420 for the verdict + a ≤3-
sentence migration note. Eval is `bun run eval:breaking` (runs fixtures through
`summarizeRelease`, deterministic accuracy + precision guard; rubric at
`src/shared/rubrics/breaking.md`). Wire field is
`ReleaseDetail.breaking?`/`migrationNotes?` (additive optional). **Follow-ups
(out of 001):** route/query population, the web "breaking" chip, the webhook
`breaking` filter, and an ingest-write integration test (no `generateContent`
harness exists today; model resolution isn't injectable without the
process-global `mock.module` leak). **Watch:** since the verdict shares the tuned
summarize prompt, run `eval:summary` + `eval:breaking` before merge to confirm
the added tags didn't regress title/summary quality (the option-2 fallback is in
git history if they do).

### 002 — as built (branch `advisor/002-whats-changed`)

`GET /v1/whats-changed?package=&from=&to=&ecosystem=` + the MCP `whats_changed`
tool — the agent-native wedge. Pure core helper `resolveUpgradeRange`
(`@buildinternet/releases-core/upgrade-range`) returns the `(from, to]` subset
(from-exclusive, to-inclusive) via the lexicographic `versionSort` key, with a
publishedAt fallback for non-numeric bounds. The route reads already-ingested
releases (no live fetch), populates `breaking`/`migrationNotes` from the
merged-001 column, and token-budgets wide ranges (newest entries kept) against
the largest `CHANGELOG_TOKEN_BRACKETS` value.

**Read-only resolution (no confused-deputy):** exact catalog source-slug match,
then a non-materializing GitHub `owner/repo` coordinate match (mirrors
`GET /v1/lookups/source-by-coordinate`). An unresolvable package → `status:
"unknown"` at **HTTP 200** (a valid answer), never a write. The MCP tool proxies
the route over the `API` service binding (single source of resolution/budget
logic). Wire types `WhatsChangedResponse`/`WhatsChangedEntry` added to
api-types; route documented in OpenAPI (coverage gate passes).

**STOP condition status:** `version-sort`/`changelog-slice` signatures
unchanged from `8f811cb5` (verified). The #1345 caveat (bare npm/PyPI names not
mapped to a source resolve to `unknown`) is **documented, not hacked** — GitHub
coordinate + exact-slug resolution covers the GitHub-tracked bulk of the
catalog; revisit resolution coverage when #1345 lands a name→source map.
**Phase 2** (`upgrade_plan` over a manifest) fans this out per dependency.

### 003 — as built (branch `advisor/003-consumption-instrumentation`)

Sink = **Option A (`logEvent` → Axiom)** — additive, no schema/table, no
migration. One PII-clean `{component:"consumption", event:"consumption",
surface, principal, operation}` event per metered request, emitted inline via
`logEvent` (a sync structured-console write — fire-and-forget, no awaited write
on the read path). **MCP** (`index.ts`) emits per billable tool call (anonymous
included — an anonymous MCP `tools/call` is agent consumption); **API**
(`recordAuth`) emits per authenticated request only (anonymous public reads are
web traffic, counted elsewhere). `principal` is a TYPE, `operation` a
low-cardinality tool name / route family — never ids/tokens/IPs. North-star
named: **programmatic queries answered per week**; APL + field-path caveat in
[consumption-telemetry.md](../docs/architecture/consumption-telemetry.md). Tests
are the emit-gating + PII guards (`workers/mcp/test/consumption.test.ts`,
`workers/api/test/consumption-telemetry.test.ts`). **Deferred:** distinct active
consumers (needs a hashed `consumerRef`; volume north-star needs none).
**Dashboard live:** [Agent demand (#1700)](https://app.axiom.co/releasessh-fbxi/dashboards/og0XbnPgbk7em1bNyd) — runbook
[consumption-demand-dashboard.md](../docs/runbooks/consumption-demand-dashboard.md).

### Run 1 dependency notes

- **002 has a soft dependency on 001.** Phase-1 `whats_changed` works without
  the `breaking` field (it returns the changelog slice + summaries), but the
  breaking flags it surfaces are far more valuable once 001 lands. Build 002's
  response shape with an optional `breaking` field from the start so 001 fills
  it in without a contract change.
- **003 is independent** and should run in parallel — it's the gauge that tells
  you whether 002 (and the downstream #1698/#1699) create real pull.

### Run 1 — not planned there (deliberately)

- #1698 (GitHub App PR bot) and #1699 (private sources) are L-effort and need
  their own design passes; they follow once 001/002 prove the wedge. Their
  issues hold the design sketch.
- Further SEO work beyond the hygiene already shipped — see #1601/#1606.

### Run 1 — findings considered and rejected

- _Add `breaking` to `releases.metadata` JSON instead of a column_: rejected —
  it must be filterable (webhook filter, `upgrade_plan`), and D1 can't index a
  JSON field efficiently. Use a real column (see plan 001).
