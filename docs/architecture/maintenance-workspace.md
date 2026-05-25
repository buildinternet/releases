# Maintenance workspace

A per-user **`~/.releases/work/`** workspace that gives agent-driven admin maintenance a durable, reviewable, cost-aware trail. When a local agent (Claude Code running a skill like [seeding-playbooks](../../src/agent/skills/seeding-playbooks/SKILL.md), `maintaining-orgs`, `managing-sources`, or `regenerating-overviews`) makes real prod mutations, the only other record is the ephemeral conversation transcript. This workspace is where the agent writes down what it set out to do, what it actually did, and what it cost.

Inspired by Browserbase's [`autobrowse`](https://github.com/browserbase/skills/tree/main/skills/autobrowse) `tasks` / `traces` / `reports` convention. Two deliberate divergences: (1) the **agent** creates the folders and writes the judgment-layer artifacts while running a maintenance skill; the CLI captures the mechanical evidence automatically (see [What the CLI captures](#what-the-cli-captures-automatically-phase-b)) but stays a pure HTTP client otherwise. (2) autobrowse keeps its workspace in CWD; ours lives in the **home dir** instead, because this work spans repos — we move between the monorepo and the [`releases-cli`](https://github.com/buildinternet/releases-cli) checkout (and worktrees), and a single per-user trail both can write to and read beats a per-checkout silo.

> **May graduate to a standalone skill.** Today each maintenance skill carries a short "Record the Run" pointer to this doc. If that pointer proves to duplicate across the seeding/maintaining/managing/overview skills, the convention can move into a dedicated `recording-maintenance-runs` skill the others reference in one line. Kept as a per-skill pointer for now (#1112).

> **Local Claude Code only, today.** The whole convention assumes a **persistent local filesystem** — the `~/.releases/work/` tree, the `RELEASES_RUN_DIR` mutation log, and the `--trace-dir` session traces all write to disk that outlives the run. A **managed-agent session runs in an ephemeral sandbox**: that disk is discarded on teardown, so anything written here evaporates before it can be read. The skills that own this convention (`seeding-playbooks`, `maintaining-orgs`) are local-Claude-Code-driven today, so this is forward-looking — but until a managed agent can sync the workspace out to durable storage (R2, the API, or a memory store) at the end of a session, treat run-recording as a local-only step and skip it inside managed sessions. It's also why the trail lives on a real home dir rather than a per-session temp dir.

## Layout

`~/.releases/work/` (honors `RELEASES_DATA_DIR` — `$RELEASES_DATA_DIR/work/` when set; sits beside the CLI's existing `logs/`, `credentials`, and caches):

```
~/.releases/work/
├── tasks/      ← durable batch definitions you (or the agent) author up front
├── runs/       ← per-run evidence: what the agent did, with raw --json outputs
└── reports/    ← cross-run session summaries (pass-rate + cost table)
```

```mermaid
flowchart LR
  task["tasks/&lt;batch&gt;.md<br/>(durable input)"] --> agent[Claude Code skill<br/>+ parallel sub-agents]
  agent -->|releases admin …| prod[(prod D1)]
  agent --> run["runs/&lt;ts&gt;-&lt;batch&gt;/summary.md<br/>+ raw --json outputs"]
  run --> report["reports/&lt;date&gt;-&lt;batch&gt;.md<br/>pass-rate + cost table"]
```

## Why the home dir (and not CWD)

- **Reachable from any checkout.** You run these skills from the monorepo and admin commands from the `releases-cli` repo. A home-dir workspace gives one audit trail both reach, instead of artifacts stranded in whichever directory happened to be CWD that session.
- **Survives worktree churn.** Worktrees come and go; `~/.releases/work/` persists, so the trail isn't lost when an isolated checkout is cleaned up.
- **Consistent with the CLI's data dir.** It uses the same root as `getDataDir()` (`RELEASES_DATA_DIR` || `~/.releases`), so maintenance artifacts sit next to the per-day `logs/`, `credentials`, and caches the CLI already owns — one place for per-user state.
- **Not committed, by design.** It's outside any repo — these are working artifacts, not source. Promote anything durable (a recurring task definition, a notable finding) into `.context/` or an issue deliberately.

## Artifacts

### `tasks/<batch>.md` — the durable input

What this batch is meant to accomplish. Authored once, not edited mid-run. Mirrors the existing `onboard → state-file → apply` shape — a task you can re-run.

```markdown
# Task: <short description>

One sentence on the goal.

## Targets

- org-slug-a
- org-slug-b

## Workflow

Which skill / model / flags. e.g. "seeding-playbooks, verified workflow, Sonnet, batches of 10".

## Done when

- [ ] Every target shows a playbook >100 chars
- [ ] Data-quality issues surfaced are filed or noted in the report
```

### `runs/<timestamp>-<batch>/summary.md` — per-run evidence

One directory per run (`YYYY-MM-DD-HHMM-<batch>/`). The agent writes a `summary.md` and drops the raw `--json` outputs of the mutations it made (the CLI already emits these) beside it, so the run is auditable after the transcript scrolls away.

```markdown
# <batch> — run <timestamp>

**Status:** completed | partial | failed
**Targets:** N | **Succeeded:** N | **Cost:** ~$X.XX (managed-session estimatedUsd + local sub-agent cost)

## Per-target

| Target | Result | Notes                                         |
| ------ | ------ | --------------------------------------------- |
| org-a  | ok     | playbook 1.2k chars                           |
| org-b  | failed | parent-saves: heredoc blocked, saved manually |

## What changed

- Raw outputs in ./outputs/ (one <slug>.json per mutation)

## Findings

- org-b feed is stale (lastFetchedAt 40d old) — candidate for follow-up
```

### `reports/<date>-<batch>.md` — durable session summary

Written once per session, after all runs. The cross-run record you can read later or share — the pass-rate / cost table is the heart of it.

```markdown
# Maintenance session — <date> — <batch>

**Scope:** <what was attempted> | **Total cost:** ~$X.XX

## Results

| Target | Runs | Final | Cost  | Notes              |
| ------ | ---- | ----- | ----- | ------------------ |
| org-a  | 1    | ok    | $0.03 | —                  |
| org-b  | 2    | ok    | $0.06 | needed manual save |

## Findings worth acting on

- <data-quality issue, coverage gap, or onboarding candidate>
```

## What the CLI captures automatically (Phase B)

The agent writes the judgment layer — task intent, the run narrative, the report's findings. The CLI owns the mechanical evidence, so the agent doesn't hand-assemble it. This capture lives in the OSS CLI repo; tracked as Phase B of #1112.

- **Admin-mutation log.** When `RELEASES_RUN_DIR` is set, every `releases admin …` write appends a JSONL line to `$RELEASES_RUN_DIR/mutations.jsonl` — `timestamp` (ISO 8601), `command` (the full invocation), `target` (HTTP method + path), `result` (status string). No per-command flags; the raw record accumulates on its own. One real line:

  ```text
  {"timestamp":"2026-05-25T14:45:22.186Z","command":"admin overview update upstash --content-file … --citations-file … --json","target":"POST /v1/orgs/upstash/overview","result":"ok 200"}
  ```

- **Managed-session traces.** Server-triggered sessions (`onboard`, `source fetch --wait`, `overview batch --wait`) already return full session records — steps, `usage.inputTokens/outputTokens/estimatedUsd`, `model`, `result` — that the CLI reads but does not persist. A `--trace-dir` flag (defaulting to `~/.releases/work/runs/`) and `admin discovery task get <id> --save <dir>` land a session as `runs/<sessionId>/{trace.json,summary.md}` in the same shape.

> **Setting `RELEASES_RUN_DIR`: inline, not a one-time `export`, in agent harnesses.** A persistent shell can `export RELEASES_RUN_DIR=…` once at the start of a batch. But Claude Code (and most agent runtimes) run **each Bash call in its own fresh shell** — the `export` does not carry across tool calls, and CWD can reset between them. A one-time export silently stops logging after the first command, with no error. When driving the CLI from an agent, pass `RELEASES_RUN_DIR=…` **inline on every mutation invocation** (or batch all mutations into a single Bash call). Phase B candidate: a `releases admin work start <batch>` subcommand that writes a sticky `~/.releases/work/.current-run` pointer the CLI auto-reads, so neither a long-lived shell nor inline threading is required.

**What this does NOT capture: sub-agent generation cost.** The mutation log and session traces cover CLI writes and server-side managed sessions. The parallel _generation_ sub-agents a skill fans out (e.g. one per org in a `maintaining-orgs` regen sweep) are usually the dominant spend, but they are not CLI sessions: **no automatic CLI/session log appears in `runs/` for them.** The only record is manual — the parent reads each sub-agent's completion summary and writes the per-sub-agent token totals into the run's `summary.md` by hand. So the "local sub-agent cost" figure in the templates above is a parent-recorded estimate in `summary.md`, not an auto-logged value alongside `mutations.jsonl` / the session traces.

Because the workspace is per-user, a session triggered from the `releases-cli` repo and a playbook batch run from the monorepo land in the same `runs/` — a single, greppable cost + mutation ledger for the money-spending operations, defense-in-depth alongside the server-side spend cap.
