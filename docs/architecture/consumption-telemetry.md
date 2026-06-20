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
  "operation": "<tool name | METHOD route-family>"
}
```

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

APL (confirm the field nesting against a live event first — worker JSON logs
land under `body.*` in this dataset, so fields are addressed as
`['body.component']` etc.):

```kusto
// North-star: programmatic queries answered, last 7 days
['releases-cloudflare-logs']
| where _time > ago(7d)
| where ['body.component'] == "consumption"
| summarize queries = count() by bin(_time, 1d), ['body.surface']
```

```kusto
// Segmentation: by principal type + operation (drop introspection)
['releases-cloudflare-logs']
| where _time > ago(7d)
| where ['body.component'] == "consumption"
| where ['body.operation'] != "GET tokens"
| summarize count() by ['body.surface'], ['body.principal'], ['body.operation']
| top 50 by count_
```

> **Dashboard:** create a saved Axiom query / dashboard tile for the north-star
> once events are flowing in prod (the dataset has no `consumption` events until
> this deploys). The field path above is the one thing to verify against a real
> event before saving the tile.

## Deliberately out of scope

- **Distinct active consumers / week.** Counting _unique_ consumers needs a
  stable per-principal id. The PII-safe path is a non-reversible hash of the
  token id (a `consumerRef`), but it only distinguishes cleanly for `relk_` /
  OAuth principals — `relu_` collapses to one bucket at the MCP boundary
  (`resolveUserKey` sets a constant `tokenId`). Deferred until the volume metric
  shows the channel is worth that resolution; the hashed-ref sketch is the
  follow-up. (Volume — the chosen north-star — needs no per-consumer id and is
  trivially PII-clean.)
- **The CLI `telemetry_events` contract** is untouched (command names only).
