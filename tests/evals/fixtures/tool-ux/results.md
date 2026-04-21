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
