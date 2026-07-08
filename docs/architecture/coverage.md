# Release coverage and grouping

Multiple releases can cover the same underlying launch (marketing post + platform changelog + app version note). The `release_coverage` table (source in `packages/core-internal/src/schema-coverage.ts`, imported as `@releases/core-internal/schema-coverage`) records the canonical release and its coverage items with an audit trail (`decided_by = human:cli | agent:<model>`, `decided_at`).

## API surface

Coverage is managed through the API worker. Routes in `workers/api/src/routes/releases.ts`:

- `GET /v1/releases/:id/coverage` — fetch the canonical release and all rows that roll up into it.
- `POST /v1/releases/:id/coverage` — link coverage items to a canonical release (admin-auth).
- `DELETE /v1/releases/:id/coverage/:coverageId` — unlink (admin-auth).

The `grouping-releases` skill is bundled with the managed discovery/worker agents; operator-driven cluster runs happen by dispatching an agent session, not via a CLI verb. Bulk re-clustering over a historical window is not currently exposed as a first-class admin endpoint — if you need it, spin up a discovery session with an explicit prompt.

## Read-path behavior

Read paths (`latest`, `list`, search, MCP) hide coverage-side rows by default; pass `--include-coverage` (CLI) or `includeCoverage: true` (MCP) to surface them.

## Cron observability

Scheduled crons write one row per execution to the generic `cron_runs` table (`workers/api/src/db/schema-cron.ts`, keyed on `cron_name` so any cron can retrofit into it — current writers include the tombstone, OAuth-client, and search-query sweeps). `/status` → Cron tab shows the last 50 rows; filter `?status=aborted,dispatch_failed` for "things worth looking at." The status enum is `running | done | degraded | dispatch_failed | aborted`.

Escalation signal: two consecutive `dispatch_failed` rows for the same `cron_name` means escalate — the likely cause is a bad deploy of a downstream worker.

Admin API: `GET /v1/admin/cron-runs{,/:id}`.

> The daily scrape-no-feed **agent sweep** that originally owned this table was retired when the scrape/agent drain moved onto the `OrgActor` DO (#1822/#1946); the `cron_runs` observability + email plumbing it introduced remains as shared infrastructure. See [remote-mode.md → OrgActor drain](remote-mode.md).

### Email notifications

A cron can send a summary email via Cloudflare Email Routing (`send_email` binding) by calling `sendCronReport(env, report)` after finalizing its run row — one report per run, regardless of status. The subject prefixes `[degraded]` / `[failed]` / `[aborted]` so inbox filters can surface failures without parsing the body. Implementation is generic (`workers/api/src/lib/{email,cron-report,notifications}.ts`).

Configuration (all in `workers/api/wrangler.jsonc` under `vars`):

- `EMAIL_NOTIFY_ENABLED` — `"false"` disables sending without removing the binding.
- `EMAIL_NOTIFY_TO` — recipient; must be verified in Cloudflare Email Routing.
- `EMAIL_FROM` — sender; domain must have Email Routing enabled.
- `ADMIN_BASE_URL` — base URL used in the body to link `/v1/admin/cron-runs/:id`.

If the `SEND_EMAIL` binding is absent (e.g. local dev, tests) the helper logs `[notifications] skipped … no_binding` and returns — the cron itself never fails on a notification error.

Ad-hoc test send (admin-auth, deployed env): `POST /v1/workflows/notifications-test` fabricates a sample `CronReport` and sends it without waiting for the cron to fire. Body fields: `{ to?, status?, cronName?, plain?, subject?, body? }`. CLI wrapper: `releases admin notify test [--status …] [--to …] [--plain]`.
