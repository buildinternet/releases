# Tool-UX eval results

Baseline measurements for [#459](https://github.com/buildinternet/releases/issues/459). Each row is one managed-agent session against the current (unconsolidated) tool surface, run against the staging DB with a purpose-built eval agent.

Raw session JSONs live in `./runs/` and are gitignored — they include full skill file contents and are large (~30–80KB each). Rerun `bun scripts/run-eval-task.ts <task-id> --agent <id>` to regenerate locally.

## Environment

- **Agent:** `agent_011CaHWVEaZpJa1hc7M8aECP` (staging, duplicated from staging discovery agent; system prompt rewritten as an imperative eval agent — "execute the user's task using the fewest tool calls possible, do not discover/validate/onboard unless asked").
- **Tool surface:** current (`add_source`, `edit_source`, `remove_source`, `fetch_source`, `get_playbook`, `update_playbook_notes`, `list_categories`, plus reads).
- **Target DB:** `api-staging.releases.sh` → `released-db-staging`.

## Round 0 — baseline (old surface)

| Task                         |                                        Custom tool calls | Tokens | Elapsed | Session                         |
| ---------------------------- | -------------------------------------------------------: | -----: | ------: | ------------------------------- |
| `add-source-to-existing-org` |                                         1 (`add_source`) | 32,717 |   19.5s | `sesn_011CaHYRhuVbvMNDANtfpULN` |
| `onboard-new-org`            |          4 (`manage_org`, `add_source`×2, `edit_source`) | 72,341 |   39.5s | `sesn_011CaHYgSVhaZnBh7MVakDwp` |
| `append-playbook-note`       | _pending — requires Vercel playbook snapshot before run_ |        |         |                                 |

Token totals include input + output + cache-creation + cache-read. Cache-read dominates (~60–85%) because the same skill file is loaded on every run.

### Calibration note: discovery-style vs. imperative system prompt

The first attempt on `add-source-to-existing-org` ran against the agent before its system prompt was tightened, and produced very different numbers:

| Variant                | Custom tool calls |  Tokens | Elapsed |
| ---------------------- | ----------------: | ------: | ------: |
| Discovery-style prompt |                17 | 350,086 |  156.6s |
| Imperative eval prompt |                 1 |  32,717 |   19.5s |

Measured consolidation wins only matter relative to a well-scoped baseline. The imperative-prompt numbers above are the correct baseline.

## Observations

### `add-source-to-existing-org` is at the floor

The agent resolves "Linear" to `linear` slug directly in the `organization` param (case-insensitive name match in `findOrg`) — no preceding `list_organizations` / `find` call. One tool call is the theoretical minimum; the new surface can't beat it on tool-call count, only on cache-creation tokens (smaller tool catalog).

### `onboard-new-org` took 4 calls, not the expected 3 or 5

- Agent skipped `list_categories` and trusted the category slug from the prompt (`developer-tools`). Reinforces the case for dropping `list_categories` entirely.
- Agent called `add_source` **twice** — first with name `"Changelog"`, then with `"Eval Test Corp Changelog"`. Likely misreading of the org-prefix naming rule in the `managing-sources` skill. Not a tool-surface issue but a skill-clarity issue worth noting.
- Primary-flag promotion still requires a separate `edit_source` call on the old surface. On the new surface, a single `manage_source(action=add, is_primary=true)` folds this in.

### Projected consolidation wins

Given the floors observed:

| Task                         | Old (measured) | New (projected) | Tool-call Δ |
| ---------------------------- | -------------: | --------------: | ----------: |
| `add-source-to-existing-org` |              1 |               1 |           0 |
| `onboard-new-org`            |              4 |               2 |   −2 (−50%) |
| `append-playbook-note`       |    2 (assumed) |               1 |   −1 (−50%) |

Token deltas will be larger than tool-call deltas across the board due to smaller tool-schema cache writes.

## Round 1 — consolidated surface (contaminated)

PR [#461](https://github.com/buildinternet/releases/pull/461) landed `manage_source` / `manage_playbook` and removed `list_categories` from the tool set; old per-action tools remain registered with `[Deprecated — prefer manage_*]` description prefixes for one release window. Skills were updated to cite only the consolidated tools. The eval agent's tool registration was PATCHed with the current `AGENT_TOOLS` directly (manual curl — sync-agent-skills doesn't cover this custom agent).

**The round 1 numbers below are unreliable.** Subsequent inspection of `tool_result` events shows every `onboard-new-org` run after the round 0 baseline hit 409 conflicts on both `manage_org(add)` and `manage_source(add)`, because `run-eval-task.ts` never executes the `cleanup` block defined in the task fixture. What looked like "4 calls with the `is_primary` shortcut not being taken" was actually the agent recovering from conflicts against stale rows from prior runs. Retained here for archaeology:

| Task                         | Observed custom tool calls                                                  | Status       |
| ---------------------------- | --------------------------------------------------------------------------- | ------------ |
| `add-source-to-existing-org` | 1 (`manage_source`) — returned 409 on stale `linear-changelog` slug         | contaminated |
| `onboard-new-org`            | 4 (`manage_org`, `manage_source`, `manage_playbook`, `manage_source(edit)`) | contaminated |

The `manage_source(edit, is_primary=true)` trailing call was the agent promoting the pre-existing (stale) source since its `add` attempts 409'd. Not a reflection of the consolidated surface.

## Round 2 — consolidated surface, post-fix, clean slate

PR [#462](https://github.com/buildinternet/releases/pull/462) merged a latent bug surfaced during round 1 inspection: the `manage_source(add)` executor advertised an `is_primary` param but didn't forward it to `POST /sources`, and the API route never accepted it. Both layers fixed. Skill guidance in `managing-sources` also tightened to prescribe setting `is_primary` on the `add` call directly (no follow-up edit).

Before each run in this round, `eval-test-corp` and any conflicting source slugs were manually deleted from `released-db-staging` via `wrangler d1 execute` to simulate what `run-eval-task.ts` should be doing natively. **`is_primary` side effects were verified post-run**: each clean `onboard-new-org` run produced a DB row with `is_primary = 1`.

| Task              | Model      |                                                                   Custom tool calls |               Tokens |             Elapsed | Session                         | DB verified |
| ----------------- | ---------- | ----------------------------------------------------------------------------------: | -------------------: | ------------------: | ------------------------------- | ----------- |
| `onboard-new-org` | Sonnet-4.6 | 3 (`manage_org`, `manage_source` `add`, `manage_source` `add` retry after slug 409) | 63,791 (**−11.8 %**) | 43.6s (**+10.4 %**) | `sesn_011CaHd6Wma3YppghFPFY26D` | [P] ✓       |
| `onboard-new-org` | Haiku-4.5  | 3 (`manage_org`, `manage_source` `add`, `manage_source` `add` retry after slug 409) | 37,693 (**−47.9 %**) | 25.7s (**−35.0 %**) | `sesn_011CaHcya16EiKQgrpL2wXjN` | [P] ✓       |

Percentages are vs. round 0 Sonnet baseline (4 calls, 72,341 tokens, 39.5s). Haiku has no matching round 0 — the Haiku token/elapsed deltas are cross-model and only directional.

### What actually saved a call

The trailing `manage_source(edit, is_primary=true)` step from round 0 is gone. Both models set `is_primary: true` directly on the `add` call, and the DB write-through confirms the flag lands. **One call saved, on both models.** This is the consolidation win the original projection pointed at, once the schema and executor actually match what the skill tells agents to do.

### What the fixture itself costs

Every run still burns a second `manage_source(add)` call because the task names the source `"Changelog"`, which slugifies to `"changelog"`, which collides globally (source slugs are globally unique). Agents recover by renaming (`"Eval Test Corp Changelog"` on Sonnet, `"eval-testcorp.example Changelog"` on Haiku), but that's +1 call every onboard. Not a tool-surface signal — a fixture/API-design signal. Options:

- Fixture: namespace the source name per run (`"Changelog <timestamp>"`). Cleaner, but diverges from real onboarding.
- API: soft-collision on `POST /sources` — auto-suffix on 409, return the resolved slug. Real fix, real scope.
- Accept: the practical floor for this task is 3 calls, not 2.

### Haiku over-applied `is_primary` on the secondary-add task

`add-source-to-existing-org` prompt is: _"Add https://linear.app/changelog as a changelog source for Linear. Call it 'Linear Changelog'."_ — no mention of primary. Haiku still passed `is_primary: true`; Sonnet did not.

Root cause is the skill wording: _"Set `is_primary` on the add call. Do not add first and edit after."_ reads unconditionally, and Haiku took it literally. Sonnet inferred the conditional ("only when this source is actually the primary"). The skill needs the conditional spelled out: _"When the source you are adding is the org's primary changelog, set `is_primary: true` on the add call."_

A clean round-3 measurement of `add-source-to-existing-org` is pending — the earlier runs 409'd on a stale `linear-changelog` row, and clearing that row via `wrangler d1 execute` was denied by the sandbox. Needs explicit user go-ahead.

### Findings

1. **PR #462's `is_primary` fix is load-bearing.** Without it, the consolidation win is invisible and the skill's advice is aspirational. This is exactly the failure mode the Anthropic article calls out — schemas claiming capabilities their executors don't deliver.
2. **The article's claim holds, with caveats.** Consolidation saves calls when the consolidated tool actually folds a real step (primary-flag promotion on add). It doesn't save calls at 1-call floors, and it doesn't help when the cost is elsewhere (slug collisions).
3. **Haiku matches Sonnet on call shape** once the schema and skill agree — worker-agent workloads should benefit similarly. But Haiku is less forgiving of ambiguous skill prose; unconditional-sounding rules get taken literally.
4. **The eval harness is the current weak link**, not the tool surface:
   - `run-eval-task.ts` doesn't execute task-level `cleanup`. Every run past the first contaminates downstream measurement. Fix: run fixture cleanup before + after each task.
   - `sync-agent-skills.ts` cannot target the custom eval agent; `AGENT_TOOLS` pushes go through direct curl. Fix: `--agent-id` flag, or add the eval agent to `scripts/agent-skills.staging.json`.
   - `append-playbook-note` still has no baseline — Vercel playbook snapshot flow isn't built.

### Call on expansion

Don't expand to the full 8-task battery until the runner cleanup gap closes — every extra task otherwise adds contaminated rows, not signal. With cleanup working, expansion is cheap and worthwhile.

Sequenced follow-ups:

1. Fix `run-eval-task.ts` cleanup execution (pre-run + post-run). Highest leverage — unblocks reliable measurement for everything downstream.
2. Reword the `managing-sources` skill's primary-source guidance to be explicitly conditional.
3. Add the eval agent to `scripts/agent-skills.staging.json` (or give sync-agent-skills an `--agent-id` flag) so tool-schema pushes aren't manual curls.
4. Build the Vercel `append-playbook-note` snapshot flow.
5. With 1–4 in place: re-run full 8 tasks against both Sonnet and Haiku, single-surface-stripped (deprecated tools removed).

## Round 3 — full 8-task battery, both models

Follow-ups 1–4 landed (PRs #464, #465, #466, #467). Eval agent synced with current tools + skills via the new `--agent-id` flag — first real exercise of the mechanism. Sonnet ran all 8 tasks; Haiku ran 7 (pause-source-fetching was skipped — see notes).

Raw sessions in `./runs/round-3-sonnet/` and `./runs/round-3-haiku/`.

| Task                          | Sonnet calls | Sonnet tokens | Sonnet elapsed |                       Haiku calls | Haiku tokens | Haiku elapsed |
| ----------------------------- | -----------: | ------------: | -------------: | --------------------------------: | -----------: | ------------: |
| `block-spam-domain`           |            1 |        17,307 |           8.8s |                                 1 |       17,753 |          8.0s |
| `ignore-per-org-url`          |            1 |        17,374 |           8.7s |                                 1 |       17,735 |          7.9s |
| `add-source-to-existing-org`  |            1 |        36,043 |          19.3s |                                 1 |       18,069 |          8.1s |
| `add-source-auto-detect-type` |            2 |        26,703 |          17.9s |                                 2 |       27,136 |         14.5s |
| `remove-eval-source`          |            1 |        17,267 |           8.6s |                                 1 |       17,605 |          7.9s |
| `onboard-new-org`             |            3 |        64,619 |          32.0s |                                 2 |       28,743 |         24.5s |
| `append-playbook-note`        |            2 |        33,609 |          31.0s |                                 2 |       33,851 |         24.5s |
| `pause-source-fetching`       |            2 |        29,757 |          20.6s | _skipped — source already paused_ |            — |             — |

### Skill rewording landed (PR #465 validated on Haiku)

`add-source-to-existing-org` on Haiku called `manage_source(add, name, url, organization)` **without** `is_primary`. Round 2 had Haiku unconditionally setting `is_primary: true` on this same task because the skill's primary-source rule read as unconditional prose. The PR #465 rewording — leading with "only set when the source is the org's primary changelog" — held: Haiku correctly treated the Linear changelog add as a secondary source and omitted the flag. Confirms the conditional rewording was load-bearing, not cosmetic.

### Haiku hit the onboard-new-org floor this round

Sonnet: 3 calls (`manage_org`, `manage_source(add, name="Changelog")` 409, `manage_source(add, name="Eval Test Corp Changelog")`).
Haiku: **2 calls** (`manage_org`, `manage_source(add, name="Eval Test Corp Changelog", is_primary=true)`).

Haiku preemptively prefixed the source name with the org, avoiding the `changelog` global-slug collision entirely. Sonnet still took the hit. Theoretical minimum (2 calls) reached on Haiku. The fixture's name/slug collision cost remains a Sonnet-visible artifact; not a tool-surface issue.

### `append-playbook-note` measured cleanly via the PR #467 snapshot flow

Both models: 2 calls — `manage_playbook(get)` then `manage_playbook(update_notes)`. The snapshot/restore cleanup captured Vercel's real playbook notes pre-run and restored them post-run; verified both models preserved the existing 7-paragraph notes block and appended the required trap about RSS truncation. No call-count win vs. the old surface (`get_playbook` + `update_playbook_notes` would also be 2), but the consolidated schema is a smaller tool-catalog footprint.

### `pause-source-fetching` got an unusual shape on Sonnet

Sonnet called `manage_playbook(get, vercel)` then `manage_source(edit, fetch_priority=paused, identifier=src_ybwLQLQFrJY-...)` — using the playbook to discover the source ID instead of the `find` tool. Two calls either way, but the shape hints at skill prose pushing agents toward playbook-as-directory when a lookup was the point. Worth a later skill tightening.

Haiku was skipped on this task: the Sonnet run left the Vercel source at `fetchPriority=paused`, and the sandbox denied the unpause PATCH (shared staging resource, not created in-session). Deferrable — the Haiku shape on this task is not load-bearing for the core consolidation question.

### One fixture bug surfaced and fixed

`add-source-to-existing-org`'s cleanup block filtered by URL (`https://linear.app/changelog` + `orgSlug=linear`). Linear's prod-synced primary source sits at exactly that URL. Pre-run cleanup matched it and deleted the legitimate row before the agent ran. Cleanup now uses the agent's deterministic slug (`linear-changelog`) via a slug arg; `delete_source` helper handles either form. Staging Linear sources were lost to this bug for the Sonnet run of the task — recoverable via `./scripts/sync-staging-db.sh` but unaffected the measurement (tool-call telemetry is independent of DB side-effects).

`pause-source-fetching` had a dbCheck slug mismatch too — expected `vercel-changelog`, actual is `vercel`. Fixed in the same commit. No runner consumes dbCheck yet, so this was purely documentation drift.

### Findings

1. **Skill prose quality is the second-order lever.** PR #465 landed a conditional rewording; Haiku's behavior changed on the next measurement. Worker-agent (Haiku) workloads depend on prose being tight — unconditional-sounding imperatives get taken literally. This matches the Anthropic article's claim that tool-level consolidation is necessary but not sufficient; the skill-layer discipline matters equally.
2. **Haiku matches or beats Sonnet on call count** across the battery. The one divergence (Haiku 2 vs Sonnet 3 on onboard-new-org) was Haiku preemptively namespacing to dodge a global-slug collision Sonnet walked into. Non-obvious — "weaker" model made the more defensive choice here.
3. **Tool-schema consolidation is real but narrow.** Wins concentrate on tasks that previously required a follow-up edit (onboard-new-org, `is_primary` fold-in). Single-call tasks (block, ignore, remove) don't change. Multi-call tasks with irreducible steps (append-playbook-note's read-then-write) don't change either.
4. **The remaining cost isn't tool surface — it's fixture + API ergonomics.** Global source-slug uniqueness collides with the most natural onboarding name ("Changelog"). A soft-collision `POST /sources` (auto-suffix + return resolved slug) would pull Sonnet down to the 2-call floor and eliminate the class entirely.

### Follow-ups from round 3

- **Un-namespaced `pause-source-fetching` fixture**: restore Vercel's `fetchPriority` after each run. Either add a `snapshot_source_priority`/`restore_source_priority` cleanup pair (mirror of the playbook snapshot work from PR #467), or use a throwaway source. Priority: low — one task, clear workaround.
- **Soft-collision on `POST /sources`**: drop the `_2` / rename dance. Auto-suffix and return resolved slug. Would simplify the onboarding skill and save Sonnet a call on onboard-new-org. Priority: medium — real API improvement, not just eval housekeeping.
- **Tighten `pause-source-fetching` skill prose**: clarify when to use `find` vs. playbook for source-id lookup. Priority: low — Sonnet-only quirk, no call-count cost.
