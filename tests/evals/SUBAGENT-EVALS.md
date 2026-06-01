# Key-free sub-agent eval runs

The `bun run eval:*` scripts call the Anthropic API directly and need
`ANTHROPIC_API_KEY` (and cost money). These are alternate drivers for the
**marketing classifier** and **release summary** evals that run entirely through
Claude Code **sub-agents** — no API key, no metered spend. Useful as a free
smoke test / prompt-sanity check.

They work because each eval's pieces are already factored out: the production
system prompts + input builders (`@releases/ai-internal/{marketing-classifier,
release-content}`) and the graders (`graders.ts`) are reused; only the execution
substrate changes.

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

### Persist (optional, either eval)

Write the Workflow's returned JSON to a file and save it into the shared results
dir alongside the bun evals:

```bash
bun tests/evals/subagent-runner.ts save marketing <workflow-result.json>
bun tests/evals/subagent-runner.ts save summary   <workflow-result.json>
# -> tests/evals/results/<eval>-subagent-<timestamp>.json (+ -latest.json)
```

All eval results land in the gitignored **`tests/evals/results/`** dir (overridable
via `RELEASES_EVAL_DIR`). See `tests/evals/results.ts`.

## Scope

Both the marketing classifier and the release summary evals are wired. The
summary Workflow mirrors `gradeStructural` inline (Tier-1) and maps the
`--judge` faithfulness tier to a Sonnet sub-agent (Tier-2). An A/B prompt/model
comparison harness and an overview-generation eval are the natural next
additions.

## Files

- `tests/evals/subagent-runner.ts` — the bun prep + save steps for both evals.
- `.claude/workflows/eval-marketing-subagents.ts` — marketing fan-out + inline
  `gradeBinary` mirror.
- `.claude/workflows/eval-summary-subagents.ts` — summary fan-out + inline
  `gradeStructural` mirror + optional Sonnet judge.

> The inline grade mirrors (`graders.ts`) live in each Workflow because the
> sandbox can't import repo modules — keep them in sync if `graders.ts` changes.
