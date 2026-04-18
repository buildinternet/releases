# Release coverage and grouping

Multiple releases can cover the same underlying launch (marketing post + platform changelog + app version note). The `release_coverage` table (source in `src/db/schema-coverage.ts`) records the canonical release and its coverage items with an audit trail (`decided_by = human:cli | agent:<model>`, `decided_at`).

## CLI verbs

Both local and remote modes support:

- `releases admin release link <canonical> <coverage...>`
- `releases admin release unlink <id>`
- `releases admin release cluster <org> [--window 30] [--model <model>] [--dry-run]`

The `cluster` verb invokes the `grouping-releases` skill via Haiku by default (override with `RELEASED_GROUPING_MODEL` or `--model claude-sonnet-4-6`). The agent's output is validated against the candidate set — hallucinated IDs and missing-from-output cases are rejected before any write.

## Read-path behavior

Read paths (`latest`, `list`, search, MCP) hide coverage-side rows by default; pass `--include-coverage` (CLI) or `includeCoverage: true` (MCP) to surface them.

## Ingest-time grouping

After a fetch wave completes, each org whose sources inserted new rows gets a single pass through `src/lib/ingest-grouping.ts` → `runIngestTimeGrouping` — drained from an `orgsNeedingGrouping` set in `src/cli/commands/fetch.ts`, alongside the existing `orgsNeedingKnowledgeUpdate` drain.

Candidate set is the org's prior 7 days. Running once per org (rather than once per source) collapses what would otherwise be N overlapping agent calls for multi-source orgs. The drain wraps each call in `try { … } catch (err) { logger.warn(…) }` so a flaky agent can never block ingest. Pass `--no-grouping` to skip.

Per-request agent output budget is `GROUPING_MAX_TOKENS = 8192` (Haiku 4.5 ceiling); requests that exceed it surface a `response truncated` error rather than a misleading JSON parse failure. Operators who want to re-cluster historical data should use the explicit `cluster` verb with a wider `--window`.

Shared helpers `rowsToCandidates` + `writeCoverageClusters` in `src/ai/grouping.ts` back both ingest-time and `release cluster` paths so they can't drift.

## Cron observability

Every scheduled-event execution of the scrape-no-feed agent sweep writes one row to the `cron_runs` table (generic over `cron_name` so future crons can retrofit). `/status` → Cron tab shows the last 50 rows; filter `?status=aborted,dispatch_failed` for "things worth looking at."

Escalation signals:

- Two consecutive `dispatch_failed` rows for the same `cron_name` means escalate — the likely cause is a bad deploy of the downstream worker.
- `aborted` with `abort_reason='anthropic_auth'` means replace the `ANTHROPIC_API_KEY` secret.
- `anthropic_credits` means top up the account.
- Stale-running rows (reconciled by the next sweep with `abort_reason='stale_running'`) are informational.

Admin API: `GET /v1/admin/cron-runs{,/:id}`. The scrape-no-feed sweep fires daily at 01:00 UTC; worst-case sessions per sweep capped by `SCRAPE_AGENT_MAX_SESSIONS` (initial deploy ships at 5, steady state 20).
