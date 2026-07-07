# Manifest Sweep → Stubs for Unlisted Domains — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A daily background sweep that discovers *unlisted* domains from real domain-lookup misses and auto-creates a cheap stub org for any that publish a valid `/.well-known/releases.json`.

**Architecture:** Two decoupled pieces. (1) **Capture** — the `/lookups/by-domain` 404 branch fire-and-forgets an upsert into a new `domain_demand` D1 table. (2) **Sweep** — a new cron, dispatched from the existing `0 6 * * *` well-known tick, pulls the highest-demand unlisted domains, probes each via the existing `createStubFromManifest` (which already fetches + validates + writes the stub with all carve-outs and the SSRF screen), stamps `swept_at`, and prunes stale junk rows.

**Tech Stack:** TypeScript (strict), Bun, Cloudflare Workers + Hono, D1 + Drizzle ORM. Schema source of truth is `packages/core/src/schema.ts`; migrations under `workers/api/migrations/`.

## Global Constraints

- **Runtime/tests:** `bun test` (worker tests run in the `workers/api` process). Type/lint gate: `bun run check`.
- **Schema pairing gate:** any `packages/core/src/schema.ts` change needs a paired migration file under `workers/api/migrations/` (CI-enforced). Migration filename format: `YYYYMMDDHHMMSS_description.sql`.
- **Logging:** worker code logs via `logEvent()` from `@releases/lib/log-event` — never the fs-backed logger.
- **D1 limits:** 100 bound params / statement; `inArray(...)` lookups chunk at 90. Not hit here (single-domain ops), but keep per-run subrequests bounded (`MAX_PER_RUN = 100`).
- **No new feature flag; no new env knob.** Gate on the existing `listing-self-serve-enabled` flag. All tunables are hardcoded constants: `SWEEP_RETRY_DAYS = 7`, `MAX_PER_RUN = 100`, `PRUNE_STALE_DAYS = 30`.
- **No new cron trigger** in `wrangler.jsonc` — piggyback the existing `0 6 * * *` block.
- **Fire-and-forget capture is fail-open** — a capture error must never affect the read response (`c.executionCtx` throws when absent in tests; guard it).
- Timestamps in `domain_demand` are integer **epoch millis** (`Date.now()`), matching `search_queries`.

---

### Task 1: `domain_demand` table + migration

**Files:**
- Modify: `packages/core/src/schema.ts` (add table near `searchQueries`, ~line 925)
- Create: `workers/api/migrations/20260708000000_add_domain_demand.sql`
- Test: `workers/api/src/cron/domain-demand-sweep.test.ts` (created here as a smoke that the migration applies + insert works; expanded in Task 4)

**Interfaces:**
- Produces: `domainDemand` table export; `DomainDemand` / `NewDomainDemand` types. Columns: `domain` (text PK), `firstSeenAt` (int, notNull), `lastSeenAt` (int, notNull), `hitCount` (int, notNull, default 1), `sweptAt` (int, nullable).

- [ ] **Step 1: Add the table to the schema**

In `packages/core/src/schema.ts`, after the `searchQueries` block / its exported types (~line 928), add. (`sqliteTable`, `text`, `integer`, `index` are already imported at the top.)

```ts
export const domainDemand = sqliteTable(
  "domain_demand",
  {
    // Normalized hostname (lowercased, no scheme/path/www) — the natural key.
    domain: text("domain").primaryKey(),
    // Epoch millis, matching search_queries. firstSeenAt is set once on insert;
    // lastSeenAt advances on every repeat lookup miss.
    firstSeenAt: integer("first_seen_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
    hitCount: integer("hit_count").notNull().default(1),
    // NULL = never probed by the sweep. Set on every sweep attempt regardless of
    // outcome (the due-filter clock).
    sweptAt: integer("swept_at"),
  },
  (table) => [
    // Candidate ordering: highest demand, least-recently-probed first.
    index("idx_domain_demand_hitcount_swept").on(table.hitCount, table.sweptAt),
  ],
);

export type DomainDemand = typeof domainDemand.$inferSelect;
export type NewDomainDemand = typeof domainDemand.$inferInsert;
```

- [ ] **Step 2: Write the migration**

Create `workers/api/migrations/20260708000000_add_domain_demand.sql`:

```sql
-- workers/api/migrations/20260708000000_add_domain_demand.sql
-- Demand signal for the manifest sweep (#1947). One row per domain that a
-- /lookups/by-domain call failed to resolve; the daily well-known tick probes
-- the highest-demand unlisted domains for a valid /.well-known/releases.json and
-- creates a stub org for any that have one. Internal-only (no public api-types).
-- Timestamps are epoch millis. swept_at NULL = never probed (the due-filter clock).
CREATE TABLE domain_demand (
  domain TEXT PRIMARY KEY,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 1,
  swept_at INTEGER
);
CREATE INDEX idx_domain_demand_hitcount_swept ON domain_demand (hit_count, swept_at);
```

- [ ] **Step 3: Write a smoke test that the migration applies and a row round-trips**

Create `workers/api/src/cron/domain-demand-sweep.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { domainDemand } from "@buildinternet/releases-core/schema";
import { createTestDb, type TestDb } from "../../test/setup.js";

describe("domain_demand table", () => {
  it("applies the migration and round-trips a row", async () => {
    const { db } = await createTestDb();
    await db.insert(domainDemand).values({
      domain: "acme.com",
      firstSeenAt: 1000,
      lastSeenAt: 1000,
    });
    const [row] = await db.select().from(domainDemand).where(eq(domainDemand.domain, "acme.com"));
    expect(row?.hitCount).toBe(1);
    expect(row?.sweptAt).toBeNull();
  });
});
```

> Note: `createTestDb` returns `{ db, ... }` and applies every migration in `workers/api/migrations/` (see `workers/api/test/setup.ts` / `tests/db-helper.ts`). If `createTestDb`'s exact return destructuring differs, match the sibling `stub-demotion.test.ts` (`import { createTestDb, type TestDb } from "../../test/setup.js"`).

- [ ] **Step 4: Run the test — expect PASS**

Run: `bun test workers/api/src/cron/domain-demand-sweep.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Type-check**

Run: `bun run check`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/schema.ts workers/api/migrations/20260708000000_add_domain_demand.sql workers/api/src/cron/domain-demand-sweep.test.ts
git commit -m "feat(schema): add domain_demand table for the manifest sweep (#1947)"
```

---

### Task 2: `recordDomainDemand` capture helper

**Files:**
- Create: `workers/api/src/lib/listing/domain-demand.ts`
- Test: `workers/api/src/lib/listing/domain-demand.test.ts`

**Interfaces:**
- Consumes: `domainDemand` table (Task 1); `type D1Db` from `../../db.js`.
- Produces: `export async function recordDomainDemand(db: D1Db, domain: string): Promise<void>` — upserts, incrementing `hit_count` and advancing `last_seen_at` on conflict. Caller is responsible for passing an already-normalized, valid hostname. Errors propagate (the route wraps the call fail-open).

- [ ] **Step 1: Write the failing test**

Create `workers/api/src/lib/listing/domain-demand.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { domainDemand } from "@buildinternet/releases-core/schema";
import { createTestDb } from "../../../test/setup.js";
import { recordDomainDemand } from "./domain-demand.js";

describe("recordDomainDemand", () => {
  it("inserts a new row with hit_count 1", async () => {
    const { db } = await createTestDb();
    await recordDomainDemand(db, "acme.com");
    const [row] = await db.select().from(domainDemand).where(eq(domainDemand.domain, "acme.com"));
    expect(row?.hitCount).toBe(1);
    expect(row?.firstSeenAt).toBe(row?.lastSeenAt);
    expect(row?.sweptAt).toBeNull();
  });

  it("increments hit_count and advances last_seen_at on a repeat", async () => {
    const { db } = await createTestDb();
    await recordDomainDemand(db, "acme.com");
    const [first] = await db.select().from(domainDemand).where(eq(domainDemand.domain, "acme.com"));
    await recordDomainDemand(db, "acme.com");
    const [second] = await db.select().from(domainDemand).where(eq(domainDemand.domain, "acme.com"));
    expect(second?.hitCount).toBe(2);
    expect(second?.firstSeenAt).toBe(first?.firstSeenAt); // unchanged
    expect(second!.lastSeenAt).toBeGreaterThanOrEqual(first!.lastSeenAt);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test workers/api/src/lib/listing/domain-demand.test.ts`
Expected: FAIL — cannot find module `./domain-demand.js`.

- [ ] **Step 3: Write the helper**

Create `workers/api/src/lib/listing/domain-demand.ts`:

```ts
import { sql } from "drizzle-orm";
import { domainDemand } from "@buildinternet/releases-core/schema";
import type { D1Db } from "../../db.js";

/**
 * Record a demand signal for an unresolved domain lookup (#1947). One row per
 * domain; `hit_count` accumulates and `last_seen_at` advances on repeat misses.
 * `domain` MUST already be normalized + validated by the caller (the by-domain
 * route runs `normalizeDomain` and rejects invalid hosts before the miss branch).
 * Upsert is a single ON CONFLICT — `domain` is the primary key.
 */
export async function recordDomainDemand(db: D1Db, domain: string): Promise<void> {
  const now = Date.now();
  await db
    .insert(domainDemand)
    .values({ domain, firstSeenAt: now, lastSeenAt: now, hitCount: 1 })
    .onConflictDoUpdate({
      target: domainDemand.domain,
      set: {
        hitCount: sql`${domainDemand.hitCount} + 1`,
        lastSeenAt: now,
      },
    });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test workers/api/src/lib/listing/domain-demand.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Type-check**

Run: `bun run check`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/lib/listing/domain-demand.ts workers/api/src/lib/listing/domain-demand.test.ts
git commit -m "feat(listing): recordDomainDemand upsert helper (#1947)"
```

---

### Task 3: Capture the miss in `/lookups/by-domain`

**Files:**
- Modify: `workers/api/src/routes/lookups.ts` (the by-domain 404 branch, ~line 751)
- Test: `workers/api/test/lookups-domain-demand.test.ts`

**Interfaces:**
- Consumes: `recordDomainDemand(db, domain)` (Task 2).

- [ ] **Step 1: Write the failing route test**

Create `workers/api/test/lookups-domain-demand.test.ts`. Drive the route in-process (see the in-process worker-route smoke pattern used elsewhere: `routes.request(path, init, env)` with a fake env). Assert a demand row exists after the response.

```ts
import { describe, it, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { domainDemand } from "@buildinternet/releases-core/schema";
import { createTestDb } from "../src/../test/setup.js"; // match sibling import depth
import { lookupsRoutes } from "../src/routes/lookups.js";

// Minimal env: the by-domain handler only needs DB. executionCtx.waitUntil must
// run the captured promise synchronously enough for the assertion — await it via
// a collected-promises shim.
function makeEnv(d1: D1Database) {
  const pending: Promise<unknown>[] = [];
  return {
    env: { DB: d1 } as any,
    executionCtx: { waitUntil: (p: Promise<unknown>) => pending.push(p) },
    drain: () => Promise.all(pending),
  };
}

describe("/lookups/by-domain demand capture", () => {
  it("records a demand row on a 404 miss", async () => {
    const { db, d1 } = await createTestDb(); // d1 = the raw D1Database handle
    const { env, executionCtx, drain } = makeEnv(d1);
    const res = await lookupsRoutes.request(
      "/lookups/by-domain?domain=unlisted-example.com",
      {},
      env,
      executionCtx,
    );
    expect(res.status).toBe(404);
    await drain();
    const [row] = await db
      .select()
      .from(domainDemand)
      .where(eq(domainDemand.domain, "unlisted-example.com"));
    expect(row?.hitCount).toBe(1);
  });

  it("records nothing when the domain resolves", async () => {
    const { db, d1 } = await createTestDb();
    await db.insert(/* organizations */ (await import("@buildinternet/releases-core/schema")).organizations).values({
      id: "org_x",
      slug: "acme",
      name: "Acme",
      domain: "acme.com",
      tier: "stub",
    });
    const { env, executionCtx, drain } = makeEnv(d1);
    const res = await lookupsRoutes.request("/lookups/by-domain?domain=acme.com", {}, env, executionCtx);
    expect(res.status).toBe(200);
    await drain();
    const rows = await db.select().from(domainDemand);
    expect(rows.length).toBe(0);
  });
});
```

> Adapt `createTestDb`'s return shape: this test needs both the drizzle handle (`db`) and the underlying `D1Database` the Hono route uses via `createDb(c.env.DB)`. If `createTestDb` doesn't expose a raw D1, use whatever the existing in-process route tests use (grep `routes.request(` under `workers/api/test/` for the canonical harness, e.g. `orgs-stub-read-surface.test.ts`) and mirror it exactly. Also confirm the exported router name (`lookupsRoutes` vs default) by opening `routes/lookups.ts`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test workers/api/test/lookups-domain-demand.test.ts`
Expected: FAIL — first test's demand row is absent (capture not wired yet).

- [ ] **Step 3: Wire the capture into the 404 branch**

In `workers/api/src/routes/lookups.ts`, add the import near the other `../lib/...` imports:

```ts
import { recordDomainDemand } from "../lib/listing/domain-demand.js";
```

Then in the by-domain handler, replace the 404 return:

```ts
    if (!orgRow && productRows.length === 0) {
      return respondError(c, new NotFoundError(`No org or product owns domain "${domain}"`));
    }
```

with a fire-and-forget capture before the same return:

```ts
    if (!orgRow && productRows.length === 0) {
      // Fire-and-forget demand signal (#1947): record the unresolved domain so the
      // manifest sweep can later probe it. Fail-open — never affect the response,
      // and c.executionCtx throws when absent (tests without an execution context).
      try {
        c.executionCtx.waitUntil(
          recordDomainDemand(db, domain).catch((err) => {
            logEvent("warn", {
              component: "listing",
              event: "domain-demand-capture-failed",
              domain,
              err: err instanceof Error ? err : String(err),
            });
          }),
        );
      } catch {
        // No execution context (e.g. some test paths) — skip capture silently.
      }
      return respondError(c, new NotFoundError(`No org or product owns domain "${domain}"`));
    }
```

Confirm `logEvent` is imported in `lookups.ts`; if not, add:

```ts
import { logEvent } from "@releases/lib/log-event";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test workers/api/test/lookups-domain-demand.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Type-check + full lookups tests**

Run: `bun run check && bun test workers/api/test/ -t "lookup"`
Expected: no type errors; existing lookup tests still green.

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/routes/lookups.ts workers/api/test/lookups-domain-demand.test.ts
git commit -m "feat(lookups): capture unresolved by-domain misses into domain_demand (#1947)"
```

---

### Task 4: The sweep + prune (`domainDemandSweep`)

**Files:**
- Create: `workers/api/src/cron/domain-demand-sweep.ts`
- Test: `workers/api/src/cron/domain-demand-sweep.test.ts` (extend the Task 1 file)

**Interfaces:**
- Consumes: `domainDemand` table; `createStubFromManifest(db, domain, { fetchImpl })` from `../lib/well-known/stub.js` (returns `{ created: boolean; orgId?: string; skippedReason?: string; locationCount?: number }`); `organizations` table (anti-join); `FLAGS`/`flag` from `@releases/lib/flags`; `createDb`/`D1Db` from `../db.js`.
- Produces: `export interface DomainDemandSweepEnv { DB: D1Database; CRON_ENABLED?: string; FLAGS?: FlagshipBinding; LISTING_SELF_SERVE_ENABLED?: string; _drizzleOverride?: D1Db; fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>; }` and `export async function domainDemandSweep(env: DomainDemandSweepEnv): Promise<{ processed: number; created: number; pruned: number }>`.

- [ ] **Step 1: Write the failing tests**

Append to `workers/api/src/cron/domain-demand-sweep.test.ts`. Use an injected `fetchImpl` that returns a valid manifest for one domain and 404 for others; use `_drizzleOverride`.

```ts
import { organizations } from "@buildinternet/releases-core/schema";
import { domainDemandSweep } from "./domain-demand-sweep.js";

const VALID_MANIFEST = JSON.stringify({
  version: 2,
  name: "Acme",
  releases: [{ url: "https://acme.com/changelog", type: "scrape" }],
});

// fetchImpl that serves a valid manifest only for `${host}` in `served`.
function manifestFetch(served: Record<string, string>) {
  return async (input: string) => {
    const url = new URL(input);
    const body = served[url.hostname];
    if (body) return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    return new Response("not found", { status: 404 });
  };
}

async function seedDemand(db: TestDb, domain: string, over: Partial<typeof domainDemand.$inferInsert> = {}) {
  await db.insert(domainDemand).values({
    domain,
    firstSeenAt: over.firstSeenAt ?? 1000,
    lastSeenAt: over.lastSeenAt ?? 1000,
    hitCount: over.hitCount ?? 1,
    sweptAt: over.sweptAt ?? null,
  });
}

describe("domainDemandSweep", () => {
  const enabledEnv = (db: TestDb, fetchImpl: any) => ({
    DB: {} as any,
    LISTING_SELF_SERVE_ENABLED: "true",
    _drizzleOverride: db,
    fetchImpl,
  });

  it("creates a stub for an unlisted domain with a valid manifest and stamps swept_at", async () => {
    const { db } = await createTestDb();
    await seedDemand(db, "acme.com");
    const r = await domainDemandSweep(enabledEnv(db, manifestFetch({ "acme.com": VALID_MANIFEST })));
    expect(r.created).toBe(1);
    const [org] = await db.select().from(organizations).where(eq(organizations.domain, "acme.com"));
    expect(org?.tier).toBe("stub");
    const [row] = await db.select().from(domainDemand).where(eq(domainDemand.domain, "acme.com"));
    expect(row?.sweptAt).not.toBeNull();
  });

  it("stamps swept_at but creates nothing when there is no manifest", async () => {
    const { db } = await createTestDb();
    await seedDemand(db, "nothing.com");
    const r = await domainDemandSweep(enabledEnv(db, manifestFetch({})));
    expect(r.created).toBe(0);
    const [row] = await db.select().from(domainDemand).where(eq(domainDemand.domain, "nothing.com"));
    expect(row?.sweptAt).not.toBeNull();
  });

  it("excludes a domain that already owns an org (no fetch, not counted)", async () => {
    const { db } = await createTestDb();
    await db.insert(organizations).values({ id: "org_a", slug: "acme", name: "Acme", domain: "acme.com", tier: "tracked" });
    await seedDemand(db, "acme.com");
    let fetched = false;
    const r = await domainDemandSweep(enabledEnv(db, async () => { fetched = true; return new Response("", { status: 404 }); }));
    expect(fetched).toBe(false);
    expect(r.processed).toBe(0);
  });

  it("skips a domain swept within SWEEP_RETRY_DAYS (due-filter)", async () => {
    const { db } = await createTestDb();
    await seedDemand(db, "recent.com", { sweptAt: Date.now() });
    const r = await domainDemandSweep(enabledEnv(db, manifestFetch({ "recent.com": VALID_MANIFEST })));
    expect(r.processed).toBe(0);
  });

  it("prunes a stale single-hit already-probed row but keeps repeat demand", async () => {
    const { db } = await createTestDb();
    const old = Date.now() - 40 * 86_400_000; // 40d ago
    await seedDemand(db, "junk.com", { hitCount: 1, sweptAt: old, lastSeenAt: old });
    await seedDemand(db, "wanted.com", { hitCount: 3, sweptAt: old, lastSeenAt: old });
    const r = await domainDemandSweep(enabledEnv(db, manifestFetch({})));
    const junk = await db.select().from(domainDemand).where(eq(domainDemand.domain, "junk.com"));
    const wanted = await db.select().from(domainDemand).where(eq(domainDemand.domain, "wanted.com"));
    expect(junk.length).toBe(0);
    expect(wanted.length).toBe(1);
    expect(r.pruned).toBe(1);
  });

  it("no-ops when the flag is off", async () => {
    const { db } = await createTestDb();
    await seedDemand(db, "acme.com");
    const r = await domainDemandSweep({ DB: {} as any, LISTING_SELF_SERVE_ENABLED: "false", _drizzleOverride: db, fetchImpl: manifestFetch({ "acme.com": VALID_MANIFEST }) });
    expect(r.created).toBe(0);
    const orgs = await db.select().from(organizations);
    expect(orgs.length).toBe(0);
  });

  it("no-ops when CRON_ENABLED=false", async () => {
    const { db } = await createTestDb();
    await seedDemand(db, "acme.com");
    const r = await domainDemandSweep({ DB: {} as any, CRON_ENABLED: "false", LISTING_SELF_SERVE_ENABLED: "true", _drizzleOverride: db, fetchImpl: manifestFetch({ "acme.com": VALID_MANIFEST }) });
    expect(r.created).toBe(0);
  });
});
```

> The manifest shape (`version: 2`, `releases[]`) must satisfy `ReleasesJsonDomainSchema`. Before finalizing, open `packages/api-types` / the schema `createStubFromManifest` validates against (grep `ReleasesJsonDomainSchema`) and copy a minimal valid example from `stub.test.ts` rather than guessing fields.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test workers/api/src/cron/domain-demand-sweep.test.ts`
Expected: FAIL — cannot find module `./domain-demand-sweep.js`.

- [ ] **Step 3: Write the sweep**

Create `workers/api/src/cron/domain-demand-sweep.ts`:

```ts
/**
 * Manifest sweep (#1947): discover UNLISTED domains from captured lookup misses
 * (domain_demand) and auto-create a stub org for any that publish a valid
 * /.well-known/releases.json. Demand-driven counterpart to well-known-sync,
 * which only reconciles already-listed orgs. Dispatched from the 0 6 * * *
 * well-known tick (same domain-manifest lane), gated on listing-self-serve-enabled.
 *
 * Reuses createStubFromManifest as the single activation core — it fetches
 * (HTTPS-only + isPrivateOrLocalHost SSRF screen), validates against the v2
 * schema, and applies every carve-out (org-exists / registry-org / reserved-slug
 * / invalid-manifest skips). The sweep never sets tracking_requested_at: a
 * sweep-discovered stub sits at the bottom of the ladder until real demand.
 */
import { and, eq, isNull, sql, desc, asc, lt, or, isNotNull } from "drizzle-orm";
import { domainDemand, organizations } from "@buildinternet/releases-core/schema";
import { logEvent } from "@releases/lib/log-event";
import { FLAGS, flag, type FlagshipBinding } from "@releases/lib/flags";
import { createDb, type D1Db } from "../db.js";
import { createStubFromManifest } from "../lib/well-known/stub.js";

const SWEEP_RETRY_DAYS = 7; // re-probe cadence for a domain the sweep found nothing on
const MAX_PER_RUN = 100; // effective daily stub-creation cap; << CF 1000-subrequest ceiling
const PRUNE_STALE_DAYS = 30; // age past which a single-hit, already-probed junk row is deleted
const DAY_MS = 86_400_000;

export interface DomainDemandSweepEnv {
  DB: D1Database;
  CRON_ENABLED?: string;
  FLAGS?: FlagshipBinding;
  LISTING_SELF_SERVE_ENABLED?: string;
  /** TEST-ONLY: use this drizzle handle instead of createDb(env.DB). */
  _drizzleOverride?: D1Db;
  /** TEST-ONLY / injectable: manifest fetch. */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

export interface DomainDemandSweepResult {
  processed: number;
  created: number;
  pruned: number;
}

export async function domainDemandSweep(
  env: DomainDemandSweepEnv,
): Promise<DomainDemandSweepResult> {
  if (env.CRON_ENABLED === "false") {
    logEvent("info", { component: "listing", event: "domain-demand-sweep-cron-disabled" });
    return { processed: 0, created: 0, pruned: 0 };
  }
  const enabled = await flag(
    env.FLAGS,
    env.LISTING_SELF_SERVE_ENABLED,
    FLAGS.listingSelfServeEnabled,
  );
  if (!enabled) {
    logEvent("info", { component: "listing", event: "domain-demand-sweep-disabled" });
    return { processed: 0, created: 0, pruned: 0 };
  }

  const db = env._drizzleOverride ?? createDb(env.DB);
  const now = Date.now();
  const cutoff = now - SWEEP_RETRY_DAYS * DAY_MS;

  // Candidates: unlisted (anti-join organizations.domain), due, highest-demand
  // then least-recently-probed. NULL swept_at sorts first under ASC in SQLite.
  const candidates = await db
    .select({ domain: domainDemand.domain })
    .from(domainDemand)
    .leftJoin(
      organizations,
      and(eq(organizations.domain, domainDemand.domain), isNull(organizations.deletedAt)),
    )
    .where(
      and(
        isNull(organizations.id),
        or(isNull(domainDemand.sweptAt), lt(domainDemand.sweptAt, cutoff)),
      ),
    )
    .orderBy(desc(domainDemand.hitCount), asc(domainDemand.sweptAt))
    .limit(MAX_PER_RUN);

  let created = 0;
  const skipped: Record<string, number> = {};

  for (const { domain } of candidates) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- sequential per-domain manifest fetch; bounded by MAX_PER_RUN
      const r = await createStubFromManifest(db, domain, { fetchImpl: env.fetchImpl });
      if (r.created) {
        created++;
        logEvent("info", {
          component: "listing",
          event: "domain-demand-stub-created",
          domain,
          orgId: r.orgId,
          locationCount: r.locationCount,
        });
      } else {
        skipped[r.skippedReason ?? "unknown"] = (skipped[r.skippedReason ?? "unknown"] ?? 0) + 1;
      }
    } catch (err) {
      logEvent("error", {
        component: "listing",
        event: "domain-demand-stub-failed",
        domain,
        err: err instanceof Error ? err : String(err),
      });
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- advance the due-filter clock per row regardless of outcome
      await db
        .update(domainDemand)
        .set({ sweptAt: now })
        .where(eq(domainDemand.domain, domain));
    } catch (err) {
      logEvent("warn", {
        component: "listing",
        event: "domain-demand-stamp-failed",
        domain,
        err: err instanceof Error ? err : String(err),
      });
    }
  }

  // Prune: single-hit, already-probed, stale junk. Never touches repeat demand
  // (hit_count > 1) or unprobed rows (swept_at NULL).
  const pruneCutoff = now - PRUNE_STALE_DAYS * DAY_MS;
  const pruneResult = await db
    .delete(domainDemand)
    .where(
      and(
        eq(domainDemand.hitCount, 1),
        isNotNull(domainDemand.sweptAt),
        lt(domainDemand.lastSeenAt, pruneCutoff),
      ),
    );
  // drizzle d1 delete returns meta with changes; fall back to 0 if unavailable.
  const pruned = (pruneResult as unknown as { meta?: { changes?: number } })?.meta?.changes ?? 0;

  logEvent("info", {
    component: "listing",
    event: "domain-demand-sweep-done",
    processed: candidates.length,
    created,
    skipped,
    pruned,
    capped: candidates.length >= MAX_PER_RUN,
  });

  return { processed: candidates.length, created, pruned };
}
```

> On `pruned` counting: match however the sibling crons read affected rows. `promote.ts` exports `affectedRows(result)` — prefer `import { affectedRows } from "../lib/well-known/promote.js"` and `const pruned = affectedRows(pruneResult)` over the inline cast, to stay consistent with `stub-demotion.ts`. Adjust the test expectation only if `affectedRows` needs a specific result shape.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test workers/api/src/cron/domain-demand-sweep.test.ts`
Expected: PASS (all sweep tests + the Task 1 smoke).

- [ ] **Step 5: Type-check**

Run: `bun run check`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/cron/domain-demand-sweep.ts workers/api/src/cron/domain-demand-sweep.test.ts
git commit -m "feat(cron): domain-demand manifest sweep + prune (#1947)"
```

---

### Task 5: Wire the sweep into the `0 6 * * *` tick

**Files:**
- Modify: `workers/api/src/index.ts` (import ~line 47; `0 6 * * *` cron block ~line 1006)

**Interfaces:**
- Consumes: `domainDemandSweep(env)` (Task 4). `env.LISTING_SELF_SERVE_ENABLED` already exists on the Env bindings (index.ts:237). `loggedDispatch` + `alertEnv` are already in scope in the scheduled handler.

- [ ] **Step 1: Add the import**

In `workers/api/src/index.ts`, next to `import { wellKnownSync } from "./cron/well-known-sync.js";` (~line 47):

```ts
import { domainDemandSweep } from "./cron/domain-demand-sweep.js";
```

- [ ] **Step 2: Dispatch it inside the existing `0 6 * * *` block**

In the `if (event.cron === "0 6 * * *") { ... }` block, add a second `ctx.waitUntil(...)` after the existing `wellKnownSync` dispatch and before `return;`:

```ts
      ctx.waitUntil(
        loggedDispatch(
          "domain-demand-sweep-cron",
          domainDemandSweep({
            DB: env.DB,
            CRON_ENABLED: env.CRON_ENABLED,
            FLAGS: env.FLAGS,
            LISTING_SELF_SERVE_ENABLED: env.LISTING_SELF_SERVE_ENABLED,
          }),
          alertEnv,
        ),
      );
```

- [ ] **Step 3: Type-check**

Run: `bun run check`
Expected: no errors.

- [ ] **Step 4: Run the worker-api test suite (sanity)**

Run: `bun test workers/api`
Expected: green (the new sweep/capture tests + existing suite).

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/index.ts
git commit -m "feat(cron): dispatch domain-demand sweep on the well-known tick (#1947)"
```

---

## Final verification

- [ ] `bun run check` — clean.
- [ ] `bun test workers/api` — green.
- [ ] `bun run db:reset:local` applies the new migration without error (fresh DB baseline + forward deltas).
- [ ] Manual reasoning pass: confirm `createStubFromManifest`'s return type fields used here (`created`, `orgId`, `skippedReason`, `locationCount`) match `stub.ts` (they do per the spec; re-verify the exact `locationCount` name before relying on it in the log).

## Rollout notes

- Migration + workers auto-apply on merge.
- `listing-self-serve-enabled` already exists in both Flagship apps and is on → the sweep is live on the first `0 6 * * *` tick after deploy. No new flag key, no new cron trigger, no manual step.
- No api-types change (the demand table is internal-only, like `tracking_requested_at`).
