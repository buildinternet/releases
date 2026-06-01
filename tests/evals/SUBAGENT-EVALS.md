# Key-free sub-agent eval runs

The `bun run eval:*` scripts call the Anthropic API directly and need
`ANTHROPIC_API_KEY` (and cost money). This is a second driver for the **marketing
classifier** eval that runs entirely through Claude Code **sub-agents** — no API
key, no metered spend. Useful as a free smoke test / prompt-sanity check.

It works because the eval's pieces are already factored out: the production
system prompt + input builder (`@releases/ai-internal/marketing-classifier`) and
the grader (`graders.ts`) are reused; only the execution substrate changes.

## What it is (and isn't)

A sub-agent is **not** equivalent to the production `client.messages.create`
call. Honest caveats:

- Instruction-heavy prompts can **degrade inside the agent-tool loop**, so a
  sub-agent run tends to _underperform_ the metered path on hard cases.
- The model snapshot and params (temperature, `max_tokens`, prompt caching) are
  not guaranteed identical to the production `claude-haiku-4-5` call.
- The Workflow uses a **schema**, which forces a clean structured verdict — so,
  unlike a raw free-text agent, there is no tag/prose leakage to parse around.

Treat it as a **free smoke test**, complementary to the metered
`bun run eval:marketing` gate — not a replacement for it.

## How to run

Three steps (the Workflow sandbox can't read files or import repo code, so the
repo-coupled halves — composing the prompt, grading — bracket it):

1. **Prep** (bun, composes the exact production prompt per fixture to a temp dir
   and prints a small manifest):

   ```bash
   bun tests/evals/subagent-runner.ts prep marketing
   ```

2. **Run the Workflow** from a Claude Code session, passing that manifest JSON as
   `args` (the Workflow fans out one Haiku sub-agent per fixture, schema-validated,
   and grades inline with the same false-positive-weighted gate as the bun eval):

   ```text
   Workflow({
     scriptPath: ".claude/workflows/eval-marketing-subagents.ts",
     args: <the JSON printed by step 1>
   })
   ```

3. The Workflow returns `{ pass, accuracy, falsePositives, falseNegatives, misses, perCase }`.

## Scope

Only the marketing classifier is wired today. The summary eval can follow the
same pattern (its `--judge` faithfulness tier maps naturally to a Sonnet
sub-agent), but is intentionally not built yet.

## Files

- `tests/evals/subagent-runner.ts` — the bun prep step.
- `.claude/workflows/eval-marketing-subagents.ts` — the sub-agent fan-out + inline
  grade (mirrors `gradeBinary` in `graders.ts`; the sandbox can't import it).
