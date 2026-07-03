# Plan 014: Fix MCP consumption telemetry for JSON-RPC batch requests

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat b1c2e87a..HEAD -- workers/mcp/src/auth.ts workers/mcp/src/index.ts workers/mcp/test/consumption.test.ts`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `b1c2e87a`, 2026-07-03

## Why this matters

Consumption telemetry (#1700) should reflect billable tool volume. JSON-RPC batch POSTs with N `tools/call` messages emit **one** event (`operation: "batch"`) because `peekMcpCall` returns `{ metered: true, tool: "batch" }` for arrays. Dashboards under-count agent usage by up to N×.

## Current state

`workers/mcp/src/auth.ts` `peekMcpCall` (~117-134):

```ts
if (Array.isArray(body)) {
  return {
    metered: body.some((m) => isBillableMethod(...)),
    tool: "batch",
  };
}
```

`workers/mcp/src/index.ts` (~67-70):

```ts
if (consumption.metered) {
  const emit = emitMcpConsumption(identity, consumption.tool ?? "unknown");
  ctx.waitUntil(emit);
}
```

Tests `workers/mcp/test/consumption.test.ts` — comment says "once per BILLABLE tool call" but no batch test.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Consumption tests | `bun test workers/mcp/test/consumption.test.ts` | all pass |
| MCP tests | `bun test workers/mcp` | all pass |
| Lint | `bun run check` | exit 0 |

## Scope

**In scope**:
- `workers/mcp/src/auth.ts`
- `workers/mcp/src/index.ts`
- `workers/mcp/test/consumption.test.ts`

**Out of scope**:
- API worker consumption (`recordAuth`)
- Changing Axiom dashboard queries (document new behavior in test comment only)
- `buildConsumptionPayload` schema changes (prefer multiple emit calls)

## Git workflow

- Branch: `advisor/014-mcp-batch-consumption-counting`
- Commit: `fix(mcp): emit consumption per billable tools/call in JSON-RPC batches`

## Steps

### Step 1: Extend peekMcpCall return type

Change to return billable operations list:

```ts
export async function peekMcpCall(
  request: Request,
): Promise<{ operations: string[] }> {
  if (request.method !== "POST") return { operations: [] };
  try {
    const body = (await request.clone().json()) as unknown;
    if (Array.isArray(body)) {
      const ops = body
        .filter((m) => isBillableMethod((m as { method?: unknown })?.method))
        .map((m) => mcpOperationLabel(m) ?? "unknown");
      return { operations: ops };
    }
    const method = (body as { method?: unknown })?.method;
    if (!isBillableMethod(method)) return { operations: [] };
    return { operations: [mcpOperationLabel(body) ?? "unknown"] };
  } catch {
    return { operations: ["unknown"] }; // parse failure → meter once (safe)
  }
}
```

Update any other callers of `peekMcpCall` (grep the repo).

**Verify**: `grep -r peekMcpCall workers/mcp` → all call sites updated.

### Step 2: Emit one event per operation

In `index.ts`:

```ts
const { operations } = await peekMcpCall(request);
for (const operation of operations) {
  ctx.waitUntil(emitMcpConsumption(identity, operation));
}
```

**Verify**: `bun run check` → exit 0.

### Step 3: Update tests

Fix existing tests expecting `.metered` / `.tool` — use `.operations`.

Add:

```ts
test("JSON-RPC batch emits one consumption op per billable tools/call", async () => {
  const r = await peekMcpCall(post([
    { method: "tools/call", params: { name: "search" } },
    { method: "tools/call", params: { name: "get_release" } },
    { method: "tools/list" },
  ]));
  expect(r.operations).toEqual(["search", "get_release"]);
});
```

**Verify**: `bun test workers/mcp/test/consumption.test.ts` → all pass.

## Test plan

- Single tools/call → one operation
- Batch with 2 tools/call + list → two operations
- tools/list only → empty operations

## Done criteria

- [ ] Batch requests emit N consumption events for N billable tool calls
- [ ] Tests updated
- [ ] `bun test workers/mcp` exit 0
- [ ] `plans/README.md` updated

## STOP conditions

- Multiple callers depend on `{ metered, tool }` shape outside mcp worker — grep whole repo before changing.
- Axiom cardinality concerns with high batch sizes — cap at e.g. 20 emits and log `truncated` (stop and ask if batches >20 are common).

## Maintenance notes

- Dashboards filtering `operation = "batch"` will see fewer events — intentional.
- Reviewers: parse-failure path still emits one `unknown` event (fail-safe metering).