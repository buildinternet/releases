# Adopt MCP spec 2026-07-28 in `workers/mcp`

**Date:** 2026-07-29
**Status:** Design approved, not yet implemented
**Sibling work:** [buildinternet/sunny#773](https://github.com/buildinternet/sunny/issues/773) and its Phase-1 PR [sunny#774](https://github.com/buildinternet/sunny/pull/774)

## Background

MCP spec `2026-07-28` shipped alongside the stable v2 TypeScript SDK. The monolithic
`@modelcontextprotocol/sdk` is retired at v1 and replaced by `@modelcontextprotocol/server`
and `@modelcontextprotocol/client` (both `2.0.0`).

The headline breaking change — protocol-level sessions are gone, MCP is stateless, and each
request carries its protocol version and client capabilities in reserved `_meta` keys — costs
us little. `workers/mcp` binds no Durable Objects, so the session state its current transport
holds is already per-isolate and best-effort. Nothing durable depends on it.

Our migration differs from sunny's in one structural way. Sunny hand-wires the SDK's own
transport, so its PR is a direct SDK swap. We serve MCP through **`agents/mcp`** (the
Cloudflare Agents SDK), which has already done this migration upstream:

- `agents@0.20.1` moves the MCP SDK from a hard dependency to peer dependencies on **both**
  v1 `@modelcontextprotocol/sdk@1.30.0` and v2 `@modelcontextprotocol/server@2.0.0` +
  `@modelcontextprotocol/client@2.0.0`.
- `agents/mcp`'s `createMcpHandler` is now the **stateless v2** handler, taking an
  `McpServerFactory`. The sessionful SDK-v1 handler we use today is renamed
  `createLegacyMcpHandler`.

So Phase 1 here is an `agents` bump plus a call-site change, not a transport rewrite.

## Current state

| Piece                        | Today                                                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `workers/mcp/package.json`   | `@modelcontextprotocol/sdk ^1.29.0`, `agents ^0.17.3`, `zod ~4.3.6`                                         |
| `workers/mcp/src/index.ts`   | `createMcpHandler(server)(request, env, ctx)` from `agents/mcp` — sessionful, SDK v1                        |
| `workers/mcp/wrangler.jsonc` | No `durable_objects`, no `migrations`, `nodejs_compat`                                                      |
| Tool registration            | ~19 raw-shape `inputSchema: { … }` sites across `mcp-agent.ts`, `follows-tools.ts`, `whats-changed-tool.ts` |
| Resources / prompts          | `ResourceTemplate` + `complete` maps (`slug-completion.ts`), `completable()` prompt args                    |
| MCP Apps UI                  | `_meta.ui.resourceUri` + `_meta.ui.csp` `resourceDomains` (`resources.ts`)                                  |
| Tests                        | `tests/mcp-test-helpers.ts` (v1 `Client` + `InMemoryTransport`) and 5 suites built on it                    |
| Registry listing             | `workers/mcp/server.json`                                                                                   |

`zod` is pinned to `~4.3.6` in this worker because SDK v1 nested its own copy
([#1367](https://github.com/buildinternet/releases/issues/1367)).

## Design

### 1. Request path

Swap the handler:

```ts
// before — agents 0.17, sessionful, SDK v1
const server = await createServer(env, ctx, { … });
return createMcpHandler(server)(request, env, ctx);

// after — agents 0.20, stateless, SDK v2
return createMcpHandler(() => createServer(env, ctx, { … }), {
  route: "/mcp",
  responseMode: "json",
  allowedOriginHostnames: [ … ],
})(request, env, ctx);
```

`createServer` becomes a **factory** the handler invokes per request rather than a value built
ahead of it.

`legacy: "stateless"` is the handler default and we keep it: 2025-era clients that still send
`initialize` keep working, served from the same factory, so the tool surface cannot drift
between eras. They stop receiving a session id — acceptable, since without Durable Objects
that id never guaranteed isolate affinity anyway.

`responseMode: "json"` makes the 2026-07-28 leg answer plain JSON instead of SSE. On the
`agents` wrapper this is a parameter, so we do not need `isLegacyRequest` branching or a
hand-rolled `WebStandardStreamableHTTPServerTransport` the way sunny does — that's the
structural win of building on `agents/mcp` rather than the SDK's transport directly.

> **Correction (2026-07-29, recorded during implementation):** the paragraph above, as
> originally written, claimed `responseMode: "json"` "preserves today's plain-JSON replies."
> That was wrong on both counts, established empirically while building Phase 1:
> `responseMode: "json"` only reaches the modern (2026-07-28) leg — the SDK's legacy fallback
> builds its own transport and answers SSE regardless of the option — and there were never any
> plain-JSON replies to preserve: `agents@0.17.3`, the handler this migration replaced,
> returned `text/event-stream` on every response path. The human partner ruled explicitly to
> keep the legacy leg SSE-framed (zero behavior change there) rather than hand-wire a second
> transport to force it to JSON. See `docs/architecture/mcp.md#transport` for the corrected,
> current account.

**Ordering is unchanged and must stay that way.** Everything above the handler runs first:

```
robots.txt / RFC 9728 metadata short-circuit
  → resolveMcpAuth (identity + staging access gate)
  → enforceMcpRateLimit (anonymous / account / machine)
  → touchLastUsed (waitUntil)
  → peekMcpCall → emitMcpConsumption (waitUntil)
  → landing page (GET /)
  → createMcpHandler(factory)
```

Two details to preserve:

- `peekMcpCall` reads the request body. It clones, so the body stays readable downstream —
  verify this still holds against the v2 handler.
- The `agents@0.20` wrapper performs its own route matching and `Host`/`Origin` validation
  (`route`, `allowedHostnames`, `allowedOriginHostnames`). Custom domains rely on Cloudflare
  routing unless set, so these must be configured explicitly or the wrapper can begin
  rejecting our own callers. Our hosts: `mcp.releases.sh`, `mcp-staging.releases.sh`,
  `mcp.releases.localhost`.

### 2. Dependencies

| Package                        | From      | To                                                                                    |
| ------------------------------ | --------- | ------------------------------------------------------------------------------------- |
| `agents`                       | `^0.17.3` | `^0.20.1`                                                                             |
| `@modelcontextprotocol/sdk`    | `^1.29.0` | removed as a direct dep                                                               |
| `@modelcontextprotocol/server` | —         | `^2.0.0`                                                                              |
| `@modelcontextprotocol/client` | —         | `^2.0.0` (tests)                                                                      |
| `zod` (worker)                 | `~4.3.6`  | relaxed to `^4.4.3` — installs `4.4.3`; #1367's pin was not load-bearing under SDK v2 |

`agents@0.20.1` declares all three MCP packages as **non-optional** peers, so v1 remains
installed as a peer even though we stop importing it.

The `zod` pin exists only because SDK v1 nested its own copy. v2 declares `zod ^4.2.0`, which
should resolve against the root `^4.4.3`. Relax the pin; keep it only if a concrete type or
runtime failure appears, and record which if so.

`workers/mcp` is a carved-out workspace with its own `bun.lock`. Refresh it in the same
commit or CI's `--frozen-lockfile` install fails.

### 3. Server surface

**Cache hints.** `McpServer`'s second constructor argument now takes per-operation cache
hints. Our tool catalog is static per deploy but auth-gated — the caller's scopes decide
which tools register — so the correct hint is a generous TTL at `private` scope:

```ts
new McpServer(
  { name, version },
  {
    cacheHints: {
      "tools/list": { ttlMs: 3_600_000, cacheScope: "private" },
      "prompts/list": { ttlMs: 3_600_000, cacheScope: "private" },
      "resources/templates/list": { ttlMs: 3_600_000, cacheScope: "private" },
    },
  },
);
```

`resources/read` stays at the SDK's conservative `{ ttlMs: 0 }` default — those reads hit D1
and return live data. Hints apply to 2026-07-28-era responses only.

**Schema wrapping.** Raw `ZodRawShape` `inputSchema` values still work in v2 via a deprecated
overload, so this is de-risking rather than a blocker. Convert anyway:

- `inputSchema: { … }` → `inputSchema: z.object({ … })` (~19 sites).
- No-argument tools drop `inputSchema` entirely instead of passing `{}`.
- `withPagination()` returns a `z.object` rather than a shape.
- Prompt `argsSchema` likewise wraps in `z.object`, keeping `completable()` on the individual
  fields.

**Unchanged, verified against the v2 type surface:**

- `ResourceTemplate(uriTemplate, { list, complete })` — same constructor, same `complete` map.
  `slug-completion.ts` needs no changes.
- `completable()` for prompt arguments — still exported, now generic over Standard Schema.
- Tool `annotations`.
- `_meta` on tools, resources, and results — which is what carries the MCP Apps UI
  `ui.resourceUri` and the `ui.csp` `resourceDomains` allowlist
  ([#1230](https://github.com/buildinternet/releases/issues/1230)).
- `resultType` is a wire-only discriminator, stripped from the handler-facing result types.
  Tool callbacks are unaffected.

### 4. Tests

**Migrate.** `tests/mcp-test-helpers.ts` drives `createServer` over `InMemoryTransport` with a
v1 `Client`; five suites build on it (`mcp-scope-enforcement`, `mcp-follows-tools`,
`mcp-tool-annotations`, `mcp-min-importance-filter`, `mcp-lookup-gate`). Move the helper to
`@modelcontextprotocol/client@2` and v2's `InMemoryTransport`. The helper's factory shape
changes; per-suite assertions should not.

`workers/mcp/test/*` (`consumption`, `read-cache`, `rate-limit`, `stub-read`) exercise layers
above the SDK and should need no changes. Any change there is a signal something moved that
was not supposed to.

**Add**, driving the real `index.ts` fetch handler so auth ordering and response mode are
actually asserted rather than assumed:

1. Modern-era `tools/list` — `_meta` protocol version + client capabilities, `Mcp-Method`
   header. Asserts the expected tool names.
2. Modern-era `tools/call` — same envelope plus `Mcp-Name`. Asserts a non-error result.
3. A modern request missing `Mcp-Method` → rejected.
4. Legacy-era `initialize` → `tools/list` — asserts 2025-era clients still work and still get
   SSE-framed replies, byte-for-byte the same shape `agents@0.17` answered with (see the
   2026-07-29 correction note above: this leg was never plain JSON, and stays SSE by design).

Manual gate before the PR: `bun run mcp:inspect:local` against the worker.

Run the consumer suites, not just the worker's own — per `CLAUDE.local.md`, husky only lints
staged files.

### 5. Docs and metadata

- `docs/architecture/mcp.md` — rewrite the transport section: both wire eras from one factory,
  stateless, `responseMode: "json"`, the `Mcp-Method`/`Mcp-Name` header requirement, the
  `tools/list` cache hints, and why `GET`/`DELETE` remain unserved.
- `workers/mcp/server.json` — bump `version`; check whether the registry schema pin
  (`2025-12-11`) has a newer revision.
- `AGENTS.md` — the MCP line stays one line pointing at the doc.

### 6. Explicitly out of scope

- **`workers/mcp/ui`** (Phase 3) — `@modelcontextprotocol/ext-apps ^1.7.3 → 1.7.5` and its own
  `@modelcontextprotocol/sdk` copy. Separate carved-out build with its own lockfile and a
  committed bundle to regenerate. The server-side `_meta` contract is unchanged, so the UI
  keeps working untouched during Phase 1.
- **better-auth 1.7 + CIMD** (Phase 2) — genuinely gated upstream-adjacent work. We run
  `1.6.23` across `workers/api` and `web` with more plugins than sunny does (api-key, passkey,
  stripe, oauth-provider, organization), so the upgrade is its own project. DCR stays
  spec-valid through the deprecation window. Own issue.
- **`subscriptions/listen`** — a real feature request
  ([#346](https://github.com/buildinternet/releases/issues/346)), not a migration item.
- **No feature flag.** This is a dependency migration with no runtime toggle worth the
  permanent registry entry and branch.

## Risks

| Risk                                                                          | Mitigation                                                                                                                                                                                        |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents@0.20` wrapper's `Host`/`Origin` validation rejects our custom domains | Set `route` and `allowedOriginHostnames` explicitly; assert in the new handler-level tests                                                                                                        |
| `peekMcpCall` body read conflicts with the v2 handler                         | Consumption test already covers this path; confirm it still passes                                                                                                                                |
| Relaxing the `zod` pin resurfaces the #1367 dual-zod split                    | Revert to `~4.3.6` and record the concrete failure                                                                                                                                                |
| Legacy clients' framing silently changes                                      | Explicit legacy-era test asserting SSE framing, byte-for-byte the `agents@0.17` shape (not `responseMode: "json"` — that option doesn't reach this leg; see the 2026-07-29 correction note above) |
| Carved-out `bun.lock` not refreshed                                           | CI `--frozen-lockfile` catches it; refresh in the same commit                                                                                                                                     |
| Stale worktree `tsc` false positives on the dual-zod split                    | Known: verify in the main checkout before believing it                                                                                                                                            |

## Success criteria

- `mcp.releases.sh` serves both 2026-07-28 and 2025-era clients from one tool factory.
- Auth, scope enforcement, rate limiting, and consumption telemetry behave exactly as before —
  their existing tests pass unmodified.
- `tools/list` carries `ttlMs` / `cacheScope`.
- MCP Apps UI resources still render, CSP allowlist intact.
- `bun run check` and the full `bun test` are green; `mcp:inspect:local` connects and lists
  tools.
