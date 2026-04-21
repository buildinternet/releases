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

## Next

- Capture Vercel playbook snapshot, run `append-playbook-note`.
- Land custom agent-tool consolidation PR (manage_source / manage_playbook / remove list_categories).
- Stand up a second agent variant (`eval-new-tools`) with the consolidated surface and same tight system prompt.
- Rerun all three tasks against the new agent; append a "Round 1 — consolidated surface" table below.
- Decide whether to expand beyond three tasks based on the round-1 deltas.
