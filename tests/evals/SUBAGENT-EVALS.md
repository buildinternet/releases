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
session's **Agent tool** against `.claude/agents/overview-writer.md` (the
generator) and the domain-neutral `.claude/agents/rubric-grader.md` (the judge)
— so its `grade` step calls the _real_ `gradeOverviewStructural` from
`graders.ts` (no inline mirror, no drift). The grader is intentionally generic:
the rubric supplies the per-eval criteria, so the same `rubric-grader` serves
any eval's Tier-2 judge step.

**One judge across the suite.** The summary Workflow's Tier-2 leg dispatches that
_same_ `rubric-grader` agent (`agentType: "rubric-grader"`), fed the _same_
`buildGraderPrompt` `<rubric>`+`<artifact>` envelope the overview and metered
paths build — there is no longer a per-eval bespoke judge. Because the sandbox
can't import `buildGraderPrompt`, the summary Workflow inlines a faithful mirror
of it (see the mirror note at the bottom). Marketing has no LLM-judge tier — it
is a binary classifier graded by `gradeBinary` (false-positive-weighted), so the
rubric-grader does not apply there (see Scope).

**Reviewable runs.** Every driver can emit a `--viewer` workspace in the
skill-creator eval-viewer convention (`outputs/` + `grading.json` +
`eval_metadata.json` per case) via the shared `materializeViewerCase` /
`materializeViewerWorkspace` helpers in `viewer.ts` — overview from its bun
`grade` step, summary and marketing from `save … --viewer`. Results always land
in the global `~/.releases/evals/results/` dir via `saveRun` (`getEvalsDir`).

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

### Why the local sub-agent path and the metered (direct-API) path diverge

Both paths run the **same model family** (Haiku for generation, Sonnet for
grading) — the weights are not the variable. What differs is _how the prompt
reaches the model_, and for format-heavy tasks (like the overview rubric) that
difference dominates the result. Three things change at once on the local path:

1. **Instruction placement.** On the metered path the production prompt **is the
   system prompt** (`messages.create({ system, messages })`) — the highest-priority
   instruction channel, evaluated in one completion. On the local path the prompt
   arrives as **tool-result data**: the `overview-writer` sub-agent runs under the
   Claude Code _agent_ system prompt (tool list, loop instructions), then Reads the
   composed prompt as the _contents of a file_. So "≤5 sections", "every section
   opens with a bold tease" land as suggestions inside a document the model is
   reading, not as system-level law. Models follow system instructions far more
   reliably than instructions embedded in retrieved content — which is exactly why
   the same rules produce clean structure on the API and random collapse/blowup
   locally.
2. **Agent-loop framing.** The sub-agent is primed to _be an agent_ (read,
   deliberate, optionally ask). That is literally why thin-content fixtures can make
   it return a clarifying question instead of an overview — a raw `messages.create`
   has no notion of asking; it just completes.
3. **Sampling params.** The Agent tool runs at whatever temperature/top-p the
   harness chooses for sub-agents; it can't be pinned. Production sets its own.
   Uncontrolled/higher temperature is why the _same_ fixture can come out a bald
   paragraph one run and a 15-section wall the next.

(There's also a smaller input-shape gap: production feeds releases as native
`search_result` blocks — which also enables citations — whereas the local path
flattens them to plain `<release>` text.)

**Consequence for measurement:** the local path's harness-induced variance can be
**larger than the prompt effect you're trying to detect**, so it is a reliable
_smoke test_ ("is the prompt followable? does it ever refuse?") but a poor
_instrument_ for a satisfied-rate delta. There is no "subscription raw-completion"
primitive exposed locally: the only way to exercise the exact production code path
(prompt-as-system, `search_result` blocks, pinned `claude-haiku-4-5`, production
params) is the billable `client.messages.create` call. Detecting a small
satisfied-rate change therefore needs **multiple metered samples per fixture**
(single samples are inside the noise band), not the free path.

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
   sub-agent and asserts the all-null discard directly. The release body is
   carried inline per fixture (tiny, ≤250B); with `--judge`, prep also includes
   the rubric **text** (not a path) inline, which the Workflow folds into the
   `buildGraderPrompt` artifact for the shared `rubric-grader`.

2. **Run the Workflow** (one Haiku sub-agent per non-discarded fixture →
   inline Tier-1 structural grade → optional `rubric-grader` (Sonnet) judge per
   fixture, fed the `BODY`+`SUMMARY` `buildGraderPrompt` artifact):

   ```text
   Workflow({
     scriptPath: ".claude/workflows/eval-summary-subagents.ts",
     args: <the JSON printed by step 1>
   })
   ```

   Returns `{ pass, total, passed, judge, failures, perCase }`. Each `perCase`
   entry carries the produced `summary` / `titleShort` / source `body` so a later
   `save … --viewer` can render it.

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

4. **Judge** — dispatch the `rubric-grader` agent (Sonnet) on each
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

### Persist + review (optional, either eval)

Write the Workflow's returned JSON to a file and save it into the shared results
dir alongside the bun evals. Add `--viewer [dir]` to also materialize an
eval-viewer workspace (same shape as overview's) so each case — every marketing
**misclassification** with the model's reason, every summary with its grades —
can be reviewed in the browser:

```bash
bun tests/evals/subagent-runner.ts save marketing <workflow-result.json>
bun tests/evals/subagent-runner.ts save summary   <workflow-result.json>
# -> ~/.releases/evals/results/<eval>-subagent-<timestamp>.json (+ -latest.json)

bun tests/evals/subagent-runner.ts save summary <workflow-result.json> --viewer
# bare --viewer -> ~/.releases/evals/runs/summary-subagent-<ts>/ ; pass a dir to override
python ~/.claude/skills/skill-creator/eval-viewer/generate_review.py \
  <runDir> --skill-name summary-eval --static <runDir>/review.html
```

The viewer reads only the directory shape, so it does not matter that summary /
marketing produce it from `save` (post-Workflow) while overview produces it from
`grade` — the `materializeViewerWorkspace` helper in `viewer.ts` is shared.

All eval results land in the global data dir at **`~/.releases/evals/results/`**
(via `getEvalsDir()`), out of the repo tree alongside the CLI's logs — the same
convention as runs/workflow logging. Viewer workspaces land under
`~/.releases/evals/runs/`. `RELEASES_EVAL_DIR` overrides the results dir;
`RELEASES_DATA_DIR` relocates the whole `~/.releases` root. See
`tests/evals/results.ts` and `getEvalsDir` in `@releases/lib/config`.

## Scope

Marketing classifier, release summary, and overview are all wired. The marketing
and summary Workflows mirror `gradeBinary` / `gradeStructural` inline (Tier-1).
Overview runs via the Agent tool, pairing the real `gradeOverviewStructural`
(Tier-1) with the generic `rubric-grader` Sonnet judge against
`src/shared/rubrics/overview.md` (Tier-2); its citation-integrity check is
metered-only. The summary `--judge` tier now dispatches that _same_
`rubric-grader` against `src/shared/rubrics/release-summary.md`, fed the same
`buildGraderPrompt` artifact (Tier-2) — one judge, not a per-eval one.

**Marketing has no Tier-2.** It is a binary classifier graded by `gradeBinary`
(accuracy floor + a hard zero-false-positive gate), so there is no rubric / no
LLM judge — the rubric-grader does not apply. A Tier-2 _"rationale quality"_
rubric (grading the model's stated reason, not just the label) was considered and
**not added**: the false-positive-weighted gate is the signal that matters, the
reason string is already surfaced verbatim in the `--viewer` workspace for human
review, and an LLM-judged rationale tier would add metered-equivalent cost and
noise for little gate value. Revisit only if reason quality becomes a tracked
metric.

**URL `evaluation` eval stays as-is.** `tests/evals/evaluation.eval.ts` is a
`bun:test` integration check (`bun run eval:evaluation`) that asserts
`evaluateChangelog()`'s deterministic, code-only URL recommendations against live
HEAD requests — no AI, no generated artifact, no per-run pass/fail record. The
global-dir `saveRun` + eval-viewer pattern targets _AI-produced artifacts you
read and grade_; neither fits a `describe`/`it` assertion suite with nothing to
render. Converting it would mean abandoning `bun:test` for no reviewer benefit,
so it is intentionally left on the `bun test` path. An A/B prompt/model
comparison harness is the natural next addition for the AI evals.

## Files

- `tests/evals/subagent-runner.ts` — bun prep + save (marketing/summary) and
  prep + grade (overview); `save … --viewer` materializes the viewer workspace.
- `tests/evals/viewer.ts` — shared eval-viewer materializer (`ViewerCase`,
  `materializeViewerCase` / `materializeViewerWorkspace`, `fieldEvidence`,
  `defaultViewerDir`); consumed by all three drivers. Unit-tested in
  `viewer.test.ts`.
- `.claude/workflows/eval-marketing-subagents.ts` — marketing fan-out + inline
  `gradeBinary` mirror; echoes each item back in `perCase` for `--viewer`.
- `.claude/workflows/eval-summary-subagents.ts` — summary fan-out + inline
  `gradeStructural` mirror + inline `buildGraderPrompt` mirror + the shared
  `rubric-grader` judge (`agentType: "rubric-grader"`).
- `.claude/agents/overview-writer.md` — Haiku generator agent (overview body).
- `.claude/agents/rubric-grader.md` — Sonnet rubric-judge agent (domain-neutral;
  the single Tier-2 judge for both overview and summary).

> **Inline sandbox mirrors — keep in sync.** The Workflow sandbox can't import
> repo modules, so three pieces are mirrored inline and must be reconciled when
> their source changes:
>
> - `gradeBinary` (marketing Workflow) ⟷ `tests/evals/graders.ts` — unchanged;
>   still matches.
> - `gradeStructural` (summary Workflow) ⟷ `tests/evals/graders.ts` — unchanged;
>   still matches (the inline copy omits the cosmetic `expected` field, as it
>   always has — logic is identical).
> - `buildGraderPrompt` (summary Workflow) ⟷ `packages/ai/src/grader-prompt.ts`
>   — added in this retrofit. The summary judge always calls it without an
>   `artifactLabel`, so the inline copy hardcodes a bare `<artifact>` header;
>   the instruction text, `OUTPUT_SCHEMA`, `escapeLabel`, and
>   `neutralizeClosingTag` are verbatim copies.
>
> The overview driver sidesteps all of this: it calls `graders.ts` and
> `buildGraderPrompt` directly from bun (no Workflow, no mirror).
