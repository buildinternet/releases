# Agents

This repo has no remote agent harness. "Agents" here means a local Claude Code session — yours — working in this checkout or against the API, driven by the skills and workflows below. There is no deployed onboarding worker and no server-hosted managed-agent fleet.

## Skills

Agent-facing skills live under `.claude/skills/`, one `SKILL.md` per skill, auto-discovered by Claude Code on a trusted clone:

- `local-ingest` — onboard or backfill a company's changelog locally: fetch pages, extract releases with the agent itself (plus parallel sub-agents), write through the `/batch` upsert. No remote fetch dispatch, no server-side extraction billing. Gated by a mandatory `robots.txt` / Content-Signal opt-out preflight.
- `backfilling-sources` — pull a source's full history via the local `backfill-source` / `backfill-sweep` Workflows (see below) instead of the billed remote update path.
- `finding-changelogs` — find, evaluate, and pick the right ingestion method for a changelog URL (feed discovery, provider detection, GitHub API, markdown, scrape fallback).
- `managing-sources` — create, delete, list, and validate sources; ignored/blocked URLs; duplicate detection.
- `parsing-changelogs` — how the fetch/parse pipeline works: feed vs. scrape adapters, incremental vs. bulk, dry-run, crawl mode, content hashing, enrichment.
- `maintaining-orgs` — routine maintenance sweep: fetch all sources for an org, regenerate overviews, spot-check data quality.
- `regenerating-overviews` — generate or refresh one org's AI overview.
- `generating-release-content` — generate the AI fields on a release (`title_generated`, `title_short`, `summary`, `composition`).
- `grouping-releases` — group releases that cover the same launch into one story.
- `seeding-playbooks` — bulk-write per-org playbooks via parallel sub-agents.
- `classify-media-relevance` — decide whether an image/video on a release page is editorial content or site chrome.
- `firecrawl-monitoring` — put a challenge-blocked scrape source on the external Firecrawl backend, or triage one already on it.

Playbooks (`knowledge_pages` rows with `scope=playbook`) and per-source `parseInstructions` still layer on top of the global skills the same way they always did — a playbook is a per-org skill, written by whichever agent session touches that org, not by humans.

`.claude/agents/` holds two local eval/grader subagents (`overview-writer`, `rubric-grader`) used by the key-free sub-agent evals, not production agents. `.claude/commands/` has one repo-local slash command, `/discover-changelog`.

## Local workflows

`.claude/workflows/` holds dynamic Workflow scripts that wrap the local-ingest primitives in a deterministic harness (fail-closed preflight, explicit window caps, budget-gated extract waves, known-URL dedup, `/batch` upsert):

- `backfill-source.ts`, `backfill-sweep.ts` — the workflows behind the `backfilling-sources` skill.
- `update-overviews.ts` — bulk overview regeneration.
- `eval-marketing-subagents.ts`, `eval-summary-subagents.ts` — sub-agent runners for the marketing-classifier and summary evals.

## Evals

`tests/evals/` holds the manual, on-demand evals (they call AI APIs, cost money, take minutes — never part of `bun run test` or CI). Grader rubrics live in `tests/evals/rubrics/` (`breaking.md`, `collection-summary.md`, `overview.md`, `release-summary.md`, `weekly-digest.md`), read from disk by the graders. See `tests/evals/SUBAGENT-EVALS.md` for the sub-agent eval flow (Claude Code subscription seats instead of the metered API) and `bun run eval:evaluation` for the one in-repo suite that isn't sub-agent-based.

## Onboarding API surface

Agents onboard and maintain orgs/products/sources through the same public REST surface everyone else uses — org/product/source create routes, `POST /releases/batch` for idempotent upserts, `/v1/lookups` for on-demand GitHub coordinate lookups, and the self-serve listing routes for owner-declared domains. See [well-known-config.md](well-known-config.md), [local-ingest.md](local-ingest.md), and [routing.md](routing.md) for the route-level detail; this doc doesn't re-document them.

## History

Managed-Agents onboarding — a Sonnet "discovery" agent and a Haiku "worker" agent hosted via Anthropic's managed-agents platform, served by `apps/discovery` — was retired in the PR for #2352: zero onboard sessions in the trailing 30 days. Routine updates had already moved off the agent path to `DeterministicUpdateWorkflow` in #1946; the legacy sandbox-engine `runDiscovery` was retired earlier in #2317.
