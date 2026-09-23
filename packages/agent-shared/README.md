# @releases/agent-shared

**Scope:** managed-agent prompts, typed tools, and grader rubrics shared by the discovery worker, the managed-agents harness, the render/sync scripts, and the eval suite. The harness runtime itself lives in `managed-agents/src/agent/`, not here.

Managed-agent prompts, typed tools, and grader rubrics. Shared by the discovery worker (`apps/discovery`), the managed-agents harness (`managed-agents/src/agent/`), the agent render/sync scripts, and the eval suite.

## Exports

Imported as `@releases/agent-shared/<subpath>`.

| Subpath                | Purpose                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| `agent-tools`          | `AGENT_TOOLS` custom-tool schemas, the MCP server/toolset definitions, and `createTypedExecutor`. |
| `discovery-prompt`     | System prompt builder for the single-agent discovery path.                                        |
| `coordinator-prompt`   | System prompt builder for the multi-agent discovery coordinator (Sonnet).                         |
| `worker-prompt`        | System prompt builder for the worker agent (Haiku).                                               |
| `onboard-task-message` | Builds the `<task>` user message that opens an onboard session.                                   |
| `memory-store-attach`  | Builds the `resources[]` payload that attaches the memory stores to a session.                    |
| `parse-args`           | Shell-style argument tokenizer.                                                                   |

Grader rubrics live in `rubrics/*.md`. They are not exported: the evals read them from disk at a path built from `import.meta.dir`.

The prompt builders and `AGENT_TOOLS` are the source of truth for the committed `managed-agents/*.agent.yaml`. After editing them, re-render with `bun scripts/render-managed-agents.ts`; CI fails on drift. Merging a change to `agent-tools.ts` or a `*-prompt.ts` file redeploys the managed agents (`.github/workflows/deploy-managed-agents.yml`).

**Private, workspace-only — not published to npm.**
