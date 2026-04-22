# Release coverage and grouping

Multiple releases can cover the same underlying launch (marketing post + platform changelog + app version note). The `release_coverage` table (source in `src/db/schema-coverage.ts`) records the canonical release and its coverage items with an audit trail (`decided_by = human:cli | agent:<model>`, `decided_at`).

## API surface

Coverage is managed through the API worker. Routes in `workers/api/src/routes/releases.ts`:

- `GET /v1/releases/:id/coverage` — fetch the canonical release and all rows that roll up into it.
- `POST /v1/releases/:id/coverage` — link coverage items to a canonical release (admin-auth).
- `DELETE /v1/releases/:id/coverage/:coverageId` — unlink (admin-auth).

The `grouping-releases` skill is bundled with the managed discovery/worker agents; operator-driven cluster runs happen by dispatching an agent session, not via a CLI verb. Bulk re-clustering over a historical window is not currently exposed as a first-class admin endpoint — if you need it, spin up a discovery session with an explicit prompt.

## Read-path behavior

Read paths (`latest`, `list`, search, MCP) hide coverage-side rows by default; pass `--include-coverage` (CLI) or `includeCoverage: true` (MCP) to surface them.

## Cron observability

Every scheduled-event execution of the scrape-no-feed agent sweep writes one row to the `cron_runs` table (generic over `cron_name` so future crons can retrofit). `/status` → Cron tab shows the last 50 rows; filter `?status=aborted,dispatch_failed` for "things worth looking at."

Escalation signals:

- Two consecutive `dispatch_failed` rows for the same `cron_name` means escalate — the likely cause is a bad deploy of the downstream worker.
- `aborted` with `abort_reason='anthropic_auth'` means replace the `ANTHROPIC_API_KEY` secret.
- `anthropic_credits` means top up the account.
- Stale-running rows (reconciled by the next sweep with `abort_reason='stale_running'`) are informational.

Admin API: `GET /v1/admin/cron-runs{,/:id}`. The scrape-no-feed sweep fires daily at 01:00 UTC; worst-case sessions per sweep capped by `SCRAPE_AGENT_MAX_SESSIONS` (initial deploy ships at 5, steady state 20).

### Email notifications

After each run finalizes, the sweep sends a summary email via Cloudflare Email Routing (`send_email` binding) — one report per run, regardless of status. The subject prefixes `[degraded]` / `[failed]` / `[aborted]` so inbox filters can surface failures without parsing the body. Implementation is generic (`workers/api/src/lib/{email,cron-report,notifications}.ts`); future crons can call `sendCronReport(env, report)` after their own `finalizeRunRow` with zero new plumbing.

Configuration (all in `workers/api/wrangler.jsonc` under `vars`):

- `EMAIL_NOTIFY_ENABLED` — `"false"` disables sending without removing the binding.
- `EMAIL_NOTIFY_TO` — recipient; must be verified in Cloudflare Email Routing.
- `EMAIL_FROM` — sender; domain must have Email Routing enabled.
- `ADMIN_BASE_URL` — base URL used in the body to link `/v1/admin/cron-runs/:id`.

If the `SEND_EMAIL` binding is absent (e.g. local dev, tests) the helper logs `[notifications] skipped … no_binding` and returns — the cron itself never fails on a notification error.

Ad-hoc test send (admin-auth, deployed env): `POST /v1/workflows/notifications-test` fabricates a sample `CronReport` and sends it without waiting for the cron to fire. Body fields: `{ to?, status?, cronName?, plain?, subject?, body? }`. CLI wrapper: `releases admin notify test [--status …] [--to …] [--plain]`.
