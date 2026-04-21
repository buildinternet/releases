# Tool-UX evals

Measures whether the custom agent-tool consolidation from [#459](https://github.com/buildinternet/releases/issues/459) makes managed agents more efficient. Compares:

- **old** — current surface: `add_source`, `edit_source`, `remove_source`, `fetch_source`, `get_playbook`, `update_playbook_notes`, `list_categories`, plus today's reads
- **new** — consolidated surface: `manage_source`, `manage_playbook`, categories folded into descriptions

Read tooling gets exercised incidentally — every task is a realistic read-then-write workflow.

## Workflow

1. Dispatch the tasks in `tasks.ts` to the old and new managed-agent variants (one worker session per task per variant).
2. Pull session telemetry from the managed-agents API.
3. Shape it as `EvalRun[]` (schema below) and write to `runs.json`.
4. Render the comparison:

   ```
   bun tests/evals/tool-ux-report.ts runs.json
   ```

The report script is pure telemetry parsing — no AI calls, no DB queries. Safe to run repeatedly.

## Input schema

```ts
interface EvalRun {
  variant: "old" | "new";
  taskId: string; // must match tasks.ts
  runIndex: number; // 1-based; multiple runs smooth noise
  toolCalls: Array<{ name: string; input?: unknown }>;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
  elapsedMs: number;
  finalResponse?: string;
  error?: string;
}
```

Target 3–5 runs per task per variant.

## What gets reported

Per task, per variant: median tool-call count, median total tokens, wrong-tool rate (calls to tools not in `expected.{variant}`), error rate. Overall: deltas between old and new.

## Grading

Round one is descriptive, not normative — we're looking at whether the agent talks to fewer tools and uses fewer tokens. Task-level correctness (did the DB end up in the right state?) is left to the dispatcher to verify using `dbCheck` hints on each task. If correctness and efficiency move in opposite directions, a Claude-as-judge grader can come later.

## Environment expectations

Some tasks assume the following exist in the target DB:

- `linear` org with at least one source
- `vercel` org with `vercel-changelog` source and an existing playbook
- `eval-cleanup-source` source (seed before the `remove-eval-source` task)
- `developer-tools` category available to `manage_org`

Cleanup predicates live on each task. Run against staging or a throwaway snapshot if you'd rather not touch prod.
