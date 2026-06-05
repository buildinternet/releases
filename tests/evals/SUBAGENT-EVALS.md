# Key-free sub-agent eval runs

The `bun run eval:*` scripts call the Anthropic API directly and need
`ANTHROPIC_API_KEY` (and cost money). These are alternate drivers for the
**marketing classifier**, **release summary**, and **overview** evals that run
entirely through Claude Code **sub-agents** — no API key, no metered spend.
Useful as a free smoke test / prompt-sanity check.

They work because each eval's pieces are already factored out: the production
system prompts + input builders (`@releases/ai-internal/{marketing-classifier,
release-content,overview-content}`) and the graders (`graders.ts`) are reused;
only the execution substrate changes.

Two driver shapes are in play. Marketing + summary fan out inside a **Workflow**
(`.claude/workflows/eval-*-subagents.ts`) whose sandbox can't import repo code,
so each mirrors `graders.ts` inline. Overview is instead driven by the parent
session's **Agent tool** against the `.claude/agents/overview-{writer,grader}.md`
definitions — so its `grade` step calls the _real_ `gradeOverviewStructural`
from `graders.ts` (no inline mirror, no drift).

## What it is (and isn't)

A sub-agent is **not** equivalent to the production `client.messages.create`
call. Honest caveats:

- Instruction-heavy prompts can **degrade inside the agent-tool loop**, so a
  sub-agent run tends to _underperform_ the metered path on hard cases.
- The model snapshot and params (temperature, `max_tokens`, prompt caching) are
  not guaranteed identical to the production `claude-haiku-4-5` call.
- The Workflows use a **schema**, which forces clean structured output — so,
  unlike a raw free-text agent, there is no XML-tag/prose leakage to parse
  around. For the summary eval this means the run smoke-tests the model's
  _content_ decisions (discard, length, faithfulness) rather than the raw-tag
  formatting that the metered `parseReleaseContent` exercises.

Treat them as **free smoke tests**, complementary to the metered
`bun run eval:{marketing,summary}` gates — not a replacement for them.

## How to run

Three steps (the Workflow sandbox can't read files or import repo code, so the
repo-coupled halves — composing the prompt, grading config — bracket it). The
spawned sub-agents themselves DO have Read access, so they read the composed
prompt files by path.

### Marketing classifier

1. **Prep** (bun — composes the exact production prompt per fixture to a temp
   dir, prints a manifest):

   ```bash
   bun tests/evals/subagent-runner.ts prep marketing
   ```

2. **Run the Workflow** from a Claude Code session, passing that manifest JSON as
   `args` (fans out one Haiku sub-agent per fixture, schema-validated, graded
   inline with the same false-positive-weighted gate as the bun eval):

   ```text
   Workflow({
     scriptPath: ".claude/workflows/eval-marketing-subagents.ts",
     args: <the JSON printed by step 1>
   })
   ```

   Returns `{ pass, accuracy, falsePositives, falseNegatives, misses, perCase }`.

### Release summary

1. **Prep** (add `--judge` to also wire the Tier-2 Sonnet faithfulness check):

   ```bash
   bun tests/evals/subagent-runner.ts prep summary           # Tier-1 structural
   bun tests/evals/subagent-runner.ts prep summary --judge   # + Sonnet judge
   ```

   Empty/boilerplate fixtures that production short-circuits before the model
   (`isEmptyContent`) are flagged in the manifest so the Workflow skips the
   sub-agent and asserts the all-null discard directly. With `--judge`, prep also
   emits a per-fixture body file + the rubric path for the judge sub-agent.

2. **Run the Workflow** (one Haiku sub-agent per non-discarded fixture →
   inline Tier-1 structural grade → optional Sonnet judge per fixture):

   ```text
   Workflow({
     scriptPath: ".claude/workflows/eval-summary-subagents.ts",
     args: <the JSON printed by step 1>
   })
   ```

   Returns `{ pass, total, passed, judge, failures, perCase }`.

### Overview

Driven by the **Agent tool**, not a Workflow — the parent session dispatches the
sub-agents and the bun `grade` step runs the real grader. Citation integrity is
NOT covered here: a free-text sub-agent can't emit Anthropic's native
`search_result` citation objects, so that check stays on the metered
`bun run eval:overview` path. This run smoke-tests overview _content_ (structure,
voice, length, faithfulness) on the subscription.

1. **Prep** (composes the production system prompt + flattened release inputs per
   fixture to a temp dir, prints a manifest with the per-fixture prompt files):

   ```bash
   bun tests/evals/subagent-runner.ts prep overview            # Tier-1 structural
   bun tests/evals/subagent-runner.ts prep overview --judge    # + Sonnet judge
   ```

2. **Generate** — dispatch the `overview-writer` agent (Haiku) once per fixture,
   each reading its `promptFile`, and write each returned body to
   `<bodiesDir>/<name>.md` (any dir you control, e.g. under `$CLAUDE_JOB_DIR/tmp`).
   The custom agent type needs a session that loaded `.claude/agents/`; otherwise
   dispatch `general-purpose` with the same instruction inlined.

3. **Grade** — runs the real `gradeOverviewStructural`:

   ```bash
   bun tests/evals/subagent-runner.ts grade overview <bodiesDir>            # structural only
   bun tests/evals/subagent-runner.ts grade overview <bodiesDir> --judge    # + writes grader prompts
   ```

   With `--judge` and no verdicts yet, it writes one `<name>.grader.txt`
   (`buildGraderPrompt` output) per fixture and stops without saving.

4. **Judge** — dispatch the `overview-grader` agent (Sonnet) on each
   `<name>.grader.txt`, collect each `{ "result": ... }`, assemble a
   `verdicts.json` map (`name -> { result }`), then finalize + save:

   ```bash
   bun tests/evals/subagent-runner.ts grade overview <bodiesDir> --judge --verdicts verdicts.json
   ```

   Saves to `tests/evals/results/overview-subagent-*.json` (+ `-latest.json`).

5. **Review in the browser (optional).** Overview quality is subjective —
   reading the rendered bodies beats scanning pass/fail lines. Add `--viewer`
   to the grade step to materialize a workspace in the
   [skill-creator eval-viewer](~/.claude/skills/skill-creator/eval-viewer)
   convention (one `eval-<name>/` per fixture, each with `outputs/overview.md`,
   `grading.json`, `eval_metadata.json`). Bare `--viewer` writes to a timestamped
   `~/.releases/evals/runs/overview-subagent-<ts>/` (same global home as the
   results); pass `--viewer <dir>` for an explicit path. The viewer is fully
   decoupled — it just reads that directory shape — so any grade run can feed it:

   ```bash
   bun tests/evals/subagent-runner.ts grade overview <bodiesDir> \
     --judge --verdicts verdicts.json --viewer
   # prints the run dir; then (headless → standalone HTML; drop --static for a live server):
   python ~/.claude/skills/skill-creator/eval-viewer/generate_review.py \
     <runDir> --skill-name overview-eval --static <runDir>/review.html
   ```

   The "Outputs" tab renders each overview inline with its grades + a feedback
   box (saved to `feedback.json`); the "Benchmark" tab shows pass-rate/timing.
   Pass `--previous-workspace <prior>` for iteration-over-iteration diffs — the
   hook for the prompt/model A/B harness noted above.

### Persist (optional, either eval)

Write the Workflow's returned JSON to a file and save it into the shared results
dir alongside the bun evals:

```bash
bun tests/evals/subagent-runner.ts save marketing <workflow-result.json>
bun tests/evals/subagent-runner.ts save summary   <workflow-result.json>
# -> ~/.releases/evals/results/<eval>-subagent-<timestamp>.json (+ -latest.json)
```

All eval results land in the global data dir at **`~/.releases/evals/results/`**
(via `getEvalsDir()`), out of the repo tree alongside the CLI's logs — the same
convention as runs/workflow logging. `RELEASES_EVAL_DIR` overrides the results
dir; `RELEASES_DATA_DIR` relocates the whole `~/.releases` root. See
`tests/evals/results.ts` and `getEvalsDir` in `@releases/lib/config`.

## Scope

Marketing classifier, release summary, and overview are all wired. The
marketing and summary Workflows mirror `gradeBinary` / `gradeStructural` inline
(Tier-1) and map the `--judge` faithfulness tier to a Sonnet sub-agent (Tier-2).
Overview runs via the Agent tool, pairing the real `gradeOverviewStructural`
(Tier-1) with the `overview-grader` Sonnet judge against
`src/shared/rubrics/overview.md` (Tier-2); its citation-integrity check is
metered-only. An A/B prompt/model comparison harness is the natural next
addition.

## Files

- `tests/evals/subagent-runner.ts` — bun prep + save (marketing/summary) and
  prep + grade (overview).
- `.claude/workflows/eval-marketing-subagents.ts` — marketing fan-out + inline
  `gradeBinary` mirror.
- `.claude/workflows/eval-summary-subagents.ts` — summary fan-out + inline
  `gradeStructural` mirror + optional Sonnet judge.
- `.claude/agents/overview-writer.md` — Haiku generator agent (overview body).
- `.claude/agents/overview-grader.md` — Sonnet rubric-judge agent.

> The inline grade mirrors (`graders.ts`) live in each Workflow because the
> sandbox can't import repo modules — keep them in sync if `graders.ts` changes.
> The overview driver sidesteps this: it calls `graders.ts` directly from bun.
