# Auth audit monitors (Axiom)

Alerting on the security-relevant auth audit events (#1432, follow-up to #1427 / #1431).
Human-auth actions emit structured `logEvent` records with `component: "auth"` that land in
the Axiom dataset **`releases-cloudflare-logs`** as a JSON string in the `body` column
(`workers/api/src/auth/audit.ts`, plus the admin routes in `workers/api/src/routes/`).
This runbook turns the queryable signal into alertable monitors.

See [logging.md → Auth audit events](../architecture/logging.md) for the full event table and
field shapes.

## The monitors (live in Axiom)

All three are **created and live** (#1432), as **Threshold** monitors routed to the shared team
notifier `sajiFns75aNFy3xSXH` (the "Email" notifier → zach@releases.sh, the same channel as the
existing managed-agent monitors):

| Monitor                     | ID                   | Run window / every | Alert when     |
| --------------------------- | -------------------- | ------------------ | -------------- |
| Auth: sign-in-failure spike | `9JK6fn2uu8TkaG3qRt` | 5m / 5m            | `count_ >= 20` |
| Auth: rate-limited surge    | `TVk9n6aRt4hN1zLdru` | 10m / 5m           | `count_ >= 10` |
| Auth: admin security action | `v9m7KpJw6pQfH1MoKW` | 10m / 10m          | `count_ >= 1`  |

### Recreating / editing them programmatically

Monitor write goes through the **Axiom management API**, not the repo or the MCP:

- `POST` (create) / `PUT` (update) `https://api.axiom.co/v2/monitors` with a management token —
  `AXIOM_MGMT_TOKEN` in the root `.env` (scoped for monitor + notifier write). This is **distinct
  from `AXIOM_OTEL_TOKEN`**, which is an OTel _ingest_ token and cannot manage monitors.
- The Axiom MCP server (`mcp__axiom__*`) exposes only **read** monitor tools (`checkMonitors`,
  `getMonitorHistory`) plus dataset/dashboard tools — it cannot create monitors, so the management
  API is the automation path. `checkMonitors` is the quickest way to verify state.
- Threshold monitor body shape: `{ name, description, aplQuery, type:"Threshold",
operator:"AboveOrEqual", threshold, intervalMinutes, rangeMinutes, triggerFromNRuns:1,
notifierIds:[…] }`. The query must return a single scalar (`summarize count()` / `sum()`) and
  must NOT carry its own time filter — the monitor applies `rangeMinutes` as the window.

Thresholds start permissive (see Tuning); all queries were validated against live
`releases-cloudflare-logs` data.

## Field-extraction primer (APL)

`body` is a JSON **string**, so parse it before reading fields. Two equivalent styles:

```kusto
// cheap pre-filter on the raw string, then parse for grouping/threshold
['releases-cloudflare-logs']
| where body contains '"component":"auth"'
| extend p = parse_json(body)
| extend event = tostring(p['event']), reason = tostring(p['reason']), env = tostring(p['environment'])
```

The `body contains '...'` pre-filters are substring matches on the raw line; they make the scan
cheap before `parse_json` runs. Keep them as the first `where` in every monitor.

**Environment scoping.** Audit events from `makeAuthAudit` (sign-in / sign-up / session) carry
`"environment":"production"`. The admin-route events (`role-changed`, `oauth-client-*`) are
logged via `logEvent` directly and do **not** carry an `environment` field — so the admin-action
monitor must NOT filter on environment (it would drop every row).

---

## Monitor 1 — `sign-in-failure` spike (credential stuffing / brute force)

**Type:** Threshold. **Run window:** 5 minutes. **Run every:** 5 minutes.
**Alert when:** `count_ >= 20` (start permissive; see tuning note).

```kusto
['releases-cloudflare-logs']
| where body contains '"component":"auth"'
| where body contains '"event":"sign-in-failure"'
| where body contains '"environment":"production"'
| summarize count()
```

Grouped variant for a dashboard / to trend reasons independently (`invalid-credentials`,
`unverified`, `rate-limited`):

```kusto
['releases-cloudflare-logs']
| where body contains '"component":"auth"'
| where body contains '"event":"sign-in-failure"'
| where body contains '"environment":"production"'
| extend reason = tostring(parse_json(body)['reason'])
| summarize count() by reason, bin(_time, 5m)
```

**When it fires:** a burst of failed credential sign-ins. Check the `reason` breakdown:

- Mostly `invalid-credentials` from many `ip` prefixes → likely credential stuffing across
  accounts. Mostly from one `ip` /24 → brute force against one account.
- Mostly `rate-limited` → the D1 limiter is already shedding the attack (see Monitor 2); this
  one corroborates.
- A spike of `unverified` → someone hammering a just-signed-up account, or a bug in the
  verification flow.

**Respond:** confirm the D1 rate limiter is on (`ENVIRONMENT === "production"` ⇒ on, fail-closed;
`AUTH_RATE_LIMIT_DISABLED` must NOT be set in prod). Pull the offending `ip` prefixes from the
grouped query (failures carry a truncated `ip`); if a single network dominates, consider a WAF
rule. Cross-check `sign-in-success` for the same window to gauge whether any attempt succeeded.

## Monitor 2 — `rate-limited` surge (limiter actively shedding load)

**Type:** Threshold. **Run window:** 10 minutes. **Run every:** 5 minutes.
**Alert when:** `count_ >= 10`.

```kusto
['releases-cloudflare-logs']
| where body contains '"component":"auth"'
| where body contains '"event":"sign-in-failure"'
| where body contains '"reason":"rate-limited"'
| where body contains '"environment":"production"'
| summarize count()
```

**When it fires:** the D1-backed limiter (#1420 / #1422) is returning 429s for `/sign-in/email` —
a strong, low-false-positive brute-force indicator (a normal user almost never trips it). This is
the highest-signal of the three; keep its threshold tighter than Monitor 1.

**Respond:** treat as an in-progress brute-force attempt. Identify the source `ip` prefix(es) via
the grouped Monitor 1 query filtered to `reason == "rate-limited"`; escalate to a WAF block if one
network dominates. The limiter is doing its job — the alert is for awareness and post-incident
review, not because protection has failed.

## Monitor 3 — admin security action (any occurrence)

**Type:** Threshold (low-volume "any occurrence"). **Run window:** 10 minutes.
**Run every:** 10 minutes. **Alert when:** `count_ >= 1`.

```kusto
['releases-cloudflare-logs']
| where body contains '"component":"auth"'
| extend p = parse_json(body)
| extend event = tostring(p['event'])
| where event in ('role-changed', 'oauth-client-created', 'oauth-client-updated',
                  'oauth-client-deleted', 'oauth-client-secret-rotated')
| summarize count()
```

To drill into _which_ action fired, swap `summarize count()` for a `project _time, event, clientId = tostring(p['clientId']), targetEmail = tostring(p['targetEmail']), fromRole = tostring(p['fromRole']), toRole = tostring(p['toRole']), actor = tostring(p['actor'])` query in the Axiom console.

> Do **not** add an `environment` filter here — these events are logged via `logEvent` directly
> and carry no `environment` field, so filtering on it drops every row.

**When it fires:** a privileged change happened — a user's role was changed
(`role-changed`, root-key only) or a "Sign in with Releases" OAuth client was created / updated /
deleted / had its secret rotated. All are root-key-gated and expected to be rare.

**Respond:** confirm the change was you/an authorized operator (all carry `actor: "root-key"`).
For `role-changed`, verify `targetEmail` → `toRole` matches an intended grant (especially any
`toRole == "admin"`). For `oauth-client-*`, confirm the `clientId` corresponds to a known client.
An unexpected occurrence means the root key may be compromised — rotate `RELEASES_API_KEY` and
audit recent admin activity.

## Optional — dashboard panels

A "Human auth" dashboard (Axiom → Dashboards; the MCP `createDashboard` tool can scaffold this)
gives context the monitors don't:

```kusto
// Sign-in success vs. failure over time (prod)
['releases-cloudflare-logs']
| where body contains '"component":"auth"' and body contains '"environment":"production"'
| extend event = tostring(parse_json(body)['event'])
| where event in ('sign-in-success', 'sign-in-failure')
| summarize count() by event, bin(_time, 1h)
```

```kusto
// Failures by reason (prod)
['releases-cloudflare-logs']
| where body contains '"event":"sign-in-failure"' and body contains '"environment":"production"'
| extend reason = tostring(parse_json(body)['reason'])
| summarize count() by reason, bin(_time, 1h)
```

```kusto
// Sign-ups over time (prod)
['releases-cloudflare-logs']
| where body contains '"event":"sign-up"' and body contains '"environment":"production"'
| summarize count() by bin(_time, 1d)
```

## Tuning

Human auth is new and low-traffic, so the thresholds above are deliberately **permissive
placeholders to avoid alert fatigue**, not measured baselines. Once real sign-in volume exists,
re-run the grouped queries over a representative window and set each threshold to a few × the
observed p95 per-window count. Monitor 2 (`rate-limited`) can stay tight — it should be near-zero
in normal operation. Revisit after the first weeks of live human-auth usage.
