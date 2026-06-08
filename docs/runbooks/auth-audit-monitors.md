# Auth audit monitors (Axiom)

Alerting on the security-relevant auth audit events (#1432, follow-up to #1427 / #1431).
Human-auth actions emit structured `logEvent` records with `component: "auth"` that land in
the Axiom dataset **`releases-cloudflare-logs`** as a JSON string in the `body` column
(`workers/api/src/auth/audit.ts`, plus the admin routes in `workers/api/src/routes/`).
This runbook turns the queryable signal into alertable monitors.

See [logging.md → Auth audit events](../architecture/logging.md) for the full event table and
field shapes.

## Why monitors are created in the Axiom UI (not in-repo)

There is **no monitors-as-code path in this repo and no programmatic create path available**:

- The only Axiom credential the project holds is `AXIOM_OTEL_TOKEN` in the root `.env` — an
  **OTel ingest** token, which cannot manage monitors.
- The Axiom MCP server (`mcp__axiom__*`) exposes only read tools for monitors
  (`checkMonitors`, `getMonitorHistory`) — it can query datasets and create _dashboards_, but
  **not create monitors**.

So each monitor below is created **manually** in the Axiom dashboard (Monitors → New monitor →
_Match event_ / _Threshold_), pasting the APL and threshold given here. The issue calls for
exactly this: build via the Axiom UI, start permissive, tighten once human auth sees real
traffic. All queries below were validated against live `releases-cloudflare-logs` data.

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
| project _time, event,
          clientId   = tostring(p['clientId']),
          targetEmail = tostring(p['targetEmail']),
          fromRole   = tostring(p['fromRole']),
          toRole     = tostring(p['toRole']),
          actor      = tostring(p['actor'])
```

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
