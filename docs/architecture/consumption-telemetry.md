# Consumption telemetry (#1700)

The demand gauge for the **agent-native channel**. Organic search is
structurally impaired (#1601), so programmatic consumption of the catalog — over
MCP and the authenticated REST API — is the growth signal that matters, and it
was previously unmeasured. The existing instrumentation measures **our** costs
and surfaces (`usage_log` = AI token spend, `search_queries` = web search log,
`telemetry_events` = CLI command names), not **consumer demand**.

This adds a PII-clean, fire-and-forget consumption event and names one
north-star. It is deliberately **distinct from cost tracking** (#1651): demand
and cost answer different questions and live on separate dashboards.

## The event

One structured log line per metered request, emitted via `logEvent` (sync
structured-console write — no D1/network, so no awaited write on the request
path; it lands in the **`releases-cloudflare-logs`** Axiom dataset like every
other worker log). Shape (identical across both surfaces so the query unions
them):

```jsonc
{
  "component": "consumption",
  "event": "consumption",
  "surface": "mcp" | "api",
  "principal": "anonymous" | "machine_token" | "user_key" | "oauth" | "root",
  "consumerRef": "root" | "anonymous" | "<sha256-hex>",
  "operation": "<tool name | METHOD route-family>"
}
```

- `consumerRef` (#1719) is a **non-reversible** per-principal bucket: fixed
  `root` / `anonymous`, else `SHA-256("consumption:" + stableTokenId)` where
  `stableTokenId` is the internal id already on the auth boundary (`relk_` row
  id, `relu_${keyId}`, `oauth_${sub}`) — never the raw secret. Implemented in
  `@releases/lib/consumption-ref`.
- `principal` is a **type only** — never a token value, user id, email, or IP.
  `machine_token` = `relk_`, `user_key` = `relu_`, `oauth` = OAuth-JWT, `root` =
  static key. Mirrors the same label set in `workers/mcp/src/auth.ts`
  (`consumptionPrincipal`) and `workers/api/src/middleware/auth.ts`
  (`apiConsumptionPrincipal`).
- `operation` is low-cardinality: the **tool name** for MCP `tools/call` (else
  the JSON-RPC method), or `"<METHOD> <route-family>"` for the API where
  route-family is the path segment after `/v1` (`/v1/orgs/vercel/releases` →
  `orgs`) — never an id-bearing path.

### Where each surface emits

- **MCP** (`workers/mcp/src/index.ts`): one event per **billable** call. Protocol
  overhead (`initialize` / `tools/list` / `ping` / `notifications/*`) is excluded
  via the shared `isBillableMethod` peek. **Anonymous calls ARE counted** — on an
  agent-native surface, an anonymous MCP `tools/call` _is_ agent consumption.
- **API** (`workers/api/src/middleware/auth.ts`, `recordAuth`): one event per
  **authenticated** request. Anonymous public reads bypass `recordAuth` and are
  **not** counted here — they are mostly web/browser traffic (tracked via
  `search_queries` + web analytics), not the agent channel. Internal MCP→API
  introspection on `GET /v1/tokens/me` shows up as `operation: "GET tokens"` —
  filter it out for pure external-consumer counts.

## North-star: **programmatic queries answered per week**

The single number to watch. It is the weekly count of consumption events — the
volume of catalog questions agents/automation answered through us. Watch it move
when #1697 (`whats_changed`), #1698 (PR bot), and #1699 (private sources) ship;
that movement is the signal the agent-native pivot is working.

`body` is a JSON **string** in `releases-cloudflare-logs` (same pattern as auth
audit events in [auth-audit-monitors.md](../runbooks/auth-audit-monitors.md)):
pre-filter on the raw string, then `parse_json(body)` for grouping.

```kusto
// North-star: programmatic queries answered, last 7 days
['releases-cloudflare-logs']
| where _time > ago(7d)
| where body contains '"component":"consumption"'
| extend p = parse_json(body)
| where tostring(p['operation']) != 'GET tokens'
| summarize queries = count() by bin(_time, 1d), surface = tostring(p['surface'])
```

```kusto
// Segmentation: by principal type + operation (drop introspection)
['releases-cloudflare-logs']
| where _time > ago(7d)
| where body contains '"component":"consumption"'
| extend p = parse_json(body)
| where tostring(p['operation']) != 'GET tokens'
| summarize count() by surface = tostring(p['surface']), principal = tostring(p['principal']), operation = tostring(p['operation'])
| top 50 by count_
```

**Dashboard:** [Agent demand (#1700)](https://app.axiom.co/releasessh-fbxi/dashboards/og0XbnPgbk7em1bNyd)
(uid `514b94db-c399-444c-b7b8-c40c9b02909c`). Runbook:
[consumption-demand-dashboard.md](../runbooks/consumption-demand-dashboard.md).

## Retention: distinct active consumers / week (#1719)

```kusto
// Distinct consumers in the dashboard time window
['releases-cloudflare-logs']
| where body contains '"component":"consumption"'
| extend p = parse_json(body)
| where tostring(p['operation']) != 'GET tokens'
| where isnotempty(tostring(p['consumerRef']))
| summarize consumers = dcount(tostring(p['consumerRef']))
```

```kusto
// Weekly distinct consumers (retention trend)
['releases-cloudflare-logs']
| where body contains '"component":"consumption"'
| extend p = parse_json(body)
| where tostring(p['operation']) != 'GET tokens'
| where isnotempty(tostring(p['consumerRef']))
| summarize consumers = dcount(tostring(p['consumerRef'])) by week = startofweek(_time)
```

`relu_` on MCP: `GET /v1/tokens/me` now returns `tokenId` (`relu_${keyId}`) so
MCP distinguishes user keys. Without that field (older API), keys collapse to
the bare `relu_` prefix bucket.

## Out of scope

- **The CLI `telemetry_events` contract** is untouched (command names only).
