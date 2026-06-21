# Agent demand dashboard (#1700)

The demand gauge for the agent-native channel. Instrumentation ships via
`logEvent` → `releases-cloudflare-logs`; this runbook owns the Axiom dashboard
that tracks the north-star.

See [consumption-telemetry.md](../architecture/consumption-telemetry.md) for the
event shape, emit points, and PII boundary.

## Dashboard (live)

| Field          | Value                                                              |
| -------------- | ------------------------------------------------------------------ |
| Name           | Agent demand (#1700)                                               |
| URL            | https://app.axiom.co/releasessh-fbxi/dashboards/og0XbnPgbk7em1bNyd |
| UID            | `514b94db-c399-444c-b7b8-c40c9b02909c`                             |
| Dataset        | `releases-cloudflare-logs`                                         |
| Default window | 7 days                                                             |
| Refresh        | 5 minutes                                                          |

Panels:

1. **Queries answered** — north-star count (excludes `GET tokens` introspection)
2. **Daily by surface** — MCP vs API trend
3. **By principal type** — anonymous / machine_token / user_key / oauth / root
4. **Top operations** — tool names and API route families
5. **Distinct consumers** — `dcount(consumerRef)` over the window (#1719)
6. **Weekly distinct consumers** — retention trend by `startofweek(_time)` (#1719)

## Field extraction (APL)

`body` is a JSON string. Pre-filter cheaply, then parse:

```kusto
['releases-cloudflare-logs']
| where body contains '"component":"consumption"'
| extend p = parse_json(body)
| extend surface = tostring(p['surface']), principal = tostring(p['principal']), operation = tostring(p['operation'])
```

Drop internal MCP→API introspection from external-consumer views:

```kusto
| where operation != 'GET tokens'
```

Distinct consumers (#1719) — requires `consumerRef` on events (post-#1719 deploy):

```kusto
| where isnotempty(tostring(p['consumerRef']))
| summarize consumers = dcount(tostring(p['consumerRef']))
```

## Ad-hoc CLI checks

```bash
# North-star total (last 7 days)
axiom query "['releases-cloudflare-logs'] | where _time > ago(7d) | where body contains '\"component\":\"consumption\"' | extend p = parse_json(body) | where tostring(p['operation']) != 'GET tokens' | summarize queries = count()"

# Top operations
axiom query "['releases-cloudflare-logs'] | where _time > ago(7d) | where body contains '\"component\":\"consumption\"' | extend p = parse_json(body) | where tostring(p['operation']) != 'GET tokens' | summarize count() by surface = tostring(p['surface']), principal = tostring(p['principal']), operation = tostring(p['operation']) | top 20 by count_"
```

## Recreating / editing programmatically

Dashboard write uses the Axiom management API via the `building-dashboards` skill
scripts (`~/.axiom.toml` deployment `axiom`):

```bash
SKILL=~/.agents/skills/building-dashboards/scripts
$SKILL/dashboard-get axiom 514b94db-c399-444c-b7b8-c40c9b02909c > dashboard.json
# edit, then:
$SKILL/dashboard-update axiom 514b94db-c399-444c-b7b8-c40c9b02909c dashboard.json
```

The Axiom MCP server exposes read-only monitor/dashboard tools; create/update
goes through these scripts or the management API (`AXIOM_MGMT_TOKEN` in root
`.env` when rotating tokens).

## Baseline (post-deploy, 2026-06-20)

After #1704 deployed, ~617 consumption events landed in the first 7 days. Most
volume is `principal: root` on admin/status routes (internal ops); MCP anonymous
traffic (`list_organizations`, `get_latest_releases`) is the early external
signal. Revisit thresholds once #1697/#1698/#1699 ship.

## `consumerRef` (#1719)

Hashed per-principal bucket on every consumption event. `relu_` MCP keys read
`tokenId` from `GET /v1/tokens/me` introspection (`relu_${keyId}`). Events
before the #1719 deploy lack `consumerRef` — retention panels filter them out.
