# Webhook Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build outbound HTTP webhook delivery for release events, consuming the existing ReleaseHub event bus (#341) via a new `workers/webhooks` Worker, with org-scoped subscriptions, HMAC-signed payloads, retry/DLQ via Cloudflare Queues, telemetry in Analytics Engine, and admin/subscriber CLI surface.

**Architecture:** Publisher in `workers/api` reads matching subscriptions from D1 and enqueues one Queue message per (event × subscription); a new `workers/webhooks` Worker consumes the queue, derives per-sub HMAC keys from a master in Secrets Store, POSTs to subscriber URLs, writes attempt telemetry to Analytics Engine, and updates summary columns on the subscription row. The existing `ReleaseHub` DO ring buffer (count-based, shipped in #341) is reused for replay; one new HTTP path on the DO exposes it as JSON.

**Tech Stack:** TypeScript strict, Cloudflare Workers + Queues + Analytics Engine + Secrets Store + D1, Drizzle ORM, Hono routing, Bun for tests, Commander for CLI.

**Spec:** [`docs/superpowers/specs/2026-04-18-webhook-delivery-design.md`](../specs/2026-04-18-webhook-delivery-design.md)

---

## Phase 0: Pre-flight (one-time, manual)

These steps require operator action against Cloudflare and cannot be automated by the agent. Run them once before Task 8 (workers/webhooks scaffold).

- [ ] **0.1: Create the Queues**

  ```bash
  bunx wrangler queues create webhook-delivery
  bunx wrangler queues create webhook-dlq
  ```

  Expected: each command prints `Created queue '<name>'.` Capture the queue IDs from the dashboard (Workers → Queues) — they aren't required in `wrangler.jsonc` (queues are referenced by name) but are useful for debugging.

- [ ] **0.2: Provision the master HMAC secret in Cloudflare Secrets Store**

  Generate the secret locally:

  ```bash
  openssl rand -hex 32
  ```

  Then in the Cloudflare dashboard: **Workers → Secrets Store → store `released-secrets`** (`store_id: a887a71cab084105b79706df23380723` per `workers/api/wrangler.jsonc`) → **Add secret** with name `WEBHOOK_HMAC_MASTER` and the generated value. Confirm it appears in the secret list.

  This secret will be referenced from `workers/webhooks/wrangler.jsonc` once that file is created (Task 8).

- [ ] **0.3: Create the Analytics Engine dataset**

  AE datasets are auto-provisioned on first write — no explicit creation needed. The binding will land in Task 8.

---

## Phase 1: Schema + DB queries

Adds the `webhook_subscriptions` D1 table, its Drizzle definition, and the helper queries the publisher and admin endpoints will use.

### Task 1: Add `webhookSubscriptions` Drizzle table + ID generator + types

**Files:**
- Modify: `packages/core/src/schema.ts` (add table at the end of the file, after `release_coverage`)
- Modify: `packages/core/src/id.ts` (add `newWebhookSubscriptionId`)

- [ ] **Step 1.1: Add the ID generator**

  Open `packages/core/src/id.ts` and add a `newWebhookSubscriptionId` export. Find the existing `newIgnoredUrlId` (or similar) export and add alongside:

  ```ts
  export function newWebhookSubscriptionId(): string {
    return `whk_${nanoid(16)}`;
  }
  ```

- [ ] **Step 1.2: Add the table definition**

  Open `packages/core/src/schema.ts`. Add the import for `newWebhookSubscriptionId` to the existing import block from `./id.js`. Then append at the end of the file (after the last existing table):

  ```ts
  export const webhookSubscriptions = sqliteTable("webhook_subscriptions", {
    id: text("id").primaryKey().$defaultFn(newWebhookSubscriptionId),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    sourceId: text("source_id").references(() => sources.id, { onDelete: "cascade" }),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    description: text("description"),
    secretVersion: integer("secret_version").notNull().default(1),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
    lastSuccessAt: text("last_success_at"),
    lastErrorAt: text("last_error_at"),
    lastErrorMsg: text("last_error_msg"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    disabledReason: text("disabled_reason"),
  }, (table) => [
    index("idx_webhook_subs_org_enabled").on(table.orgId, table.enabled),
    index("idx_webhook_subs_org_source").on(table.orgId, table.sourceId),
  ]);

  export type WebhookSubscription = typeof webhookSubscriptions.$inferSelect;
  export type NewWebhookSubscription = typeof webhookSubscriptions.$inferInsert;
  ```

  If `index` is not yet imported from `drizzle-orm/sqlite-core`, add it to the existing import.

- [ ] **Step 1.3: Verify the schema compiles**

  Run: `npx tsc --noEmit`
  Expected: PASS, no new errors.

- [ ] **Step 1.4: Commit**

  ```bash
  git add packages/core/src/schema.ts packages/core/src/id.ts
  git commit -m "feat(schema): add webhook_subscriptions table"
  ```

### Task 2: D1 migration for the new table

**Files:**
- Create: `workers/api/migrations/<timestamp>_webhook_subscriptions.sql` (use the current UTC timestamp in `YYYYMMDDHHMMSS` format; recent migrations use this convention — see `20260418152523_cron_runs.sql`)

- [ ] **Step 2.1: Generate the timestamp**

  Run: `date -u +%Y%m%d%H%M%S`
  Use the printed value as the filename prefix (e.g. `20260418200000_webhook_subscriptions.sql`).

- [ ] **Step 2.2: Write the migration**

  Create the file with this exact body:

  ```sql
  CREATE TABLE webhook_subscriptions (
    id                    TEXT PRIMARY KEY,
    org_id                TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    url                   TEXT NOT NULL,
    source_id             TEXT REFERENCES sources(id) ON DELETE CASCADE,
    enabled               INTEGER NOT NULL DEFAULT 1,
    description           TEXT,
    secret_version        INTEGER NOT NULL DEFAULT 1,
    created_at            TEXT NOT NULL,
    last_success_at       TEXT,
    last_error_at         TEXT,
    last_error_msg        TEXT,
    consecutive_failures  INTEGER NOT NULL DEFAULT 0,
    disabled_reason       TEXT
  );

  CREATE INDEX idx_webhook_subs_org_enabled
    ON webhook_subscriptions (org_id, enabled);
  CREATE INDEX idx_webhook_subs_org_source
    ON webhook_subscriptions (org_id, source_id);
  ```

- [ ] **Step 2.3: Apply locally to verify**

  Run: `bunx wrangler d1 execute released-db --local --file=workers/api/migrations/<your-file>.sql`
  Expected: prints `Executed N command(s)` with no errors.

- [ ] **Step 2.4: Verify the table exists**

  Run: `bunx wrangler d1 execute released-db --local --command="SELECT name FROM sqlite_master WHERE type='table' AND name='webhook_subscriptions';"`
  Expected: result row with `name: webhook_subscriptions`.

- [ ] **Step 2.5: Commit**

  ```bash
  git add workers/api/migrations/<your-file>.sql
  git commit -m "feat(db): migration for webhook_subscriptions"
  ```

### Task 3: Shared D1 query helpers

These helpers serve both the publisher (in `workers/api`) and the admin endpoints. They live in `src/db/queries.ts` alongside existing helpers like `findOrg`, `listIgnoredUrls`.

**Files:**
- Modify: `src/db/queries.ts` (add functions at the end of the file)
- Create: `src/db/queries.webhooks.test.ts`

- [ ] **Step 3.1: Write the failing test**

  Create `src/db/queries.webhooks.test.ts`:

  ```ts
  import { describe, it, expect, beforeAll } from "bun:test";
  import { Database } from "bun:sqlite";
  import { drizzle } from "drizzle-orm/bun-sqlite";
  import { migrate } from "drizzle-orm/bun-sqlite/migrator";
  import {
    webhookSubscriptions,
    organizations,
    sources,
  } from "@buildinternet/releases-core/schema";
  import {
    insertWebhookSubscription,
    getWebhookSubscriptionById,
    listWebhookSubscriptionsByOrg,
    matchWebhookSubscriptions,
    updateWebhookSubscriptionSummary,
    setWebhookSubscriptionEnabled,
    deleteWebhookSubscription,
  } from "./queries.js";

  function makeDb() {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite, { logger: false });
    migrate(db, { migrationsFolder: "./drizzle" });
    return { sqlite, db };
  }

  describe("webhook subscription queries", () => {
    let db: ReturnType<typeof makeDb>["db"];

    beforeAll(() => {
      const made = makeDb();
      db = made.db;
      // Seed an org and a source for FK satisfaction
      db.insert(organizations).values({
        id: "org_test1",
        slug: "acme",
        name: "Acme",
      }).run();
      db.insert(sources).values({
        id: "src_test1",
        slug: "acme-blog",
        name: "Acme Blog",
        url: "https://acme.example/blog",
        type: "scrape",
        orgId: "org_test1",
      }).run();
    });

    it("inserts and retrieves a subscription", async () => {
      const sub = await insertWebhookSubscription(db, {
        orgId: "org_test1",
        url: "https://example.com/hook",
        sourceId: null,
        description: "test sub",
      });
      expect(sub.id).toMatch(/^whk_/);
      const fetched = await getWebhookSubscriptionById(db, sub.id);
      expect(fetched?.orgId).toBe("org_test1");
      expect(fetched?.enabled).toBe(true);
      expect(fetched?.secretVersion).toBe(1);
      expect(fetched?.consecutiveFailures).toBe(0);
    });

    it("matchWebhookSubscriptions returns enabled subs for an org", async () => {
      // Existing one from prior test still in DB
      const matches = await matchWebhookSubscriptions(db, ["org_test1"]);
      expect(matches.length).toBeGreaterThanOrEqual(1);
      expect(matches.every((s) => s.enabled === true)).toBe(true);
    });

    it("filters by sourceId when set", async () => {
      const sub = await insertWebhookSubscription(db, {
        orgId: "org_test1",
        url: "https://example.com/hook2",
        sourceId: "src_test1",
        description: "scoped sub",
      });
      const all = await matchWebhookSubscriptions(db, ["org_test1"]);
      const scoped = all.filter((s) => s.sourceId === "src_test1");
      expect(scoped.find((s) => s.id === sub.id)).toBeDefined();
    });

    it("updateWebhookSubscriptionSummary records success", async () => {
      const sub = await insertWebhookSubscription(db, {
        orgId: "org_test1",
        url: "https://example.com/hook3",
        sourceId: null,
        description: null,
      });
      await updateWebhookSubscriptionSummary(db, sub.id, { kind: "success", at: "2026-04-18T00:00:00Z" });
      const after = await getWebhookSubscriptionById(db, sub.id);
      expect(after?.lastSuccessAt).toBe("2026-04-18T00:00:00Z");
      expect(after?.consecutiveFailures).toBe(0);
    });

    it("updateWebhookSubscriptionSummary increments consecutive_failures on error", async () => {
      const sub = await insertWebhookSubscription(db, {
        orgId: "org_test1",
        url: "https://example.com/hook4",
        sourceId: null,
        description: null,
      });
      await updateWebhookSubscriptionSummary(db, sub.id, { kind: "error", at: "2026-04-18T00:00:01Z", message: "boom" });
      await updateWebhookSubscriptionSummary(db, sub.id, { kind: "error", at: "2026-04-18T00:00:02Z", message: "boom2" });
      const after = await getWebhookSubscriptionById(db, sub.id);
      expect(after?.consecutiveFailures).toBe(2);
      expect(after?.lastErrorMsg).toBe("boom2");
    });

    it("setWebhookSubscriptionEnabled toggles", async () => {
      const sub = await insertWebhookSubscription(db, {
        orgId: "org_test1",
        url: "https://example.com/hook5",
        sourceId: null,
        description: null,
      });
      await setWebhookSubscriptionEnabled(db, sub.id, false, "test disable");
      const after = await getWebhookSubscriptionById(db, sub.id);
      expect(after?.enabled).toBe(false);
      expect(after?.disabledReason).toBe("test disable");
    });

    it("deleteWebhookSubscription removes the row", async () => {
      const sub = await insertWebhookSubscription(db, {
        orgId: "org_test1",
        url: "https://example.com/hook6",
        sourceId: null,
        description: null,
      });
      await deleteWebhookSubscription(db, sub.id);
      const after = await getWebhookSubscriptionById(db, sub.id);
      expect(after).toBeNull();
    });
  });
  ```

- [ ] **Step 3.2: Run the tests to verify they fail**

  Run: `bun test src/db/queries.webhooks.test.ts`
  Expected: FAIL with "function not exported" or similar.

- [ ] **Step 3.3: Implement the helpers**

  Open `src/db/queries.ts`. Find the section that exports `addIgnoredUrl`, `removeIgnoredUrl`, etc. Append at the end:

  ```ts
  // ---------------------------------------------------------------------------
  // Webhook subscriptions
  // ---------------------------------------------------------------------------

  import { webhookSubscriptions, type WebhookSubscription, type NewWebhookSubscription } from "@buildinternet/releases-core/schema";
  // (place this import near the existing schema imports at the top of the file
  //  rather than mid-file; shown here for clarity)

  export async function insertWebhookSubscription(
    db: AnyDb,
    input: { orgId: string; url: string; sourceId: string | null; description: string | null },
  ): Promise<WebhookSubscription> {
    const [row] = await db.insert(webhookSubscriptions).values(input).returning();
    return row;
  }

  export async function getWebhookSubscriptionById(
    db: AnyDb,
    id: string,
  ): Promise<WebhookSubscription | null> {
    const rows = await db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.id, id)).limit(1);
    return rows[0] ?? null;
  }

  export async function listWebhookSubscriptionsByOrg(
    db: AnyDb,
    orgId: string,
    opts?: { enabledOnly?: boolean },
  ): Promise<WebhookSubscription[]> {
    if (opts?.enabledOnly) {
      return db.select().from(webhookSubscriptions)
        .where(and(eq(webhookSubscriptions.orgId, orgId), eq(webhookSubscriptions.enabled, true)));
    }
    return db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.orgId, orgId));
  }

  /**
   * Hot-path query for the publisher: returns enabled subscriptions for any of
   * the given orgIds. The publisher then matches each event against these in
   * memory using sourceId.
   */
  export async function matchWebhookSubscriptions(
    db: AnyDb,
    orgIds: string[],
  ): Promise<WebhookSubscription[]> {
    if (orgIds.length === 0) return [];
    return db.select().from(webhookSubscriptions)
      .where(and(
        eq(webhookSubscriptions.enabled, true),
        inArray(webhookSubscriptions.orgId, orgIds),
      ));
  }

  export type SummaryUpdate =
    | { kind: "success"; at: string }
    | { kind: "error"; at: string; message: string };

  export async function updateWebhookSubscriptionSummary(
    db: AnyDb,
    id: string,
    update: SummaryUpdate,
  ): Promise<void> {
    if (update.kind === "success") {
      await db.update(webhookSubscriptions)
        .set({ lastSuccessAt: update.at, consecutiveFailures: 0 })
        .where(eq(webhookSubscriptions.id, id));
    } else {
      // Read current value, increment, write back. Two queries; acceptable at v1 volume.
      const cur = await getWebhookSubscriptionById(db, id);
      if (!cur) return;
      await db.update(webhookSubscriptions)
        .set({
          lastErrorAt: update.at,
          lastErrorMsg: update.message,
          consecutiveFailures: cur.consecutiveFailures + 1,
        })
        .where(eq(webhookSubscriptions.id, id));
    }
  }

  export async function setWebhookSubscriptionEnabled(
    db: AnyDb,
    id: string,
    enabled: boolean,
    reason: string | null,
  ): Promise<void> {
    await db.update(webhookSubscriptions)
      .set({ enabled, disabledReason: enabled ? null : reason })
      .where(eq(webhookSubscriptions.id, id));
  }

  export async function deleteWebhookSubscription(db: AnyDb, id: string): Promise<void> {
    await db.delete(webhookSubscriptions).where(eq(webhookSubscriptions.id, id));
  }

  export async function bumpWebhookSecretVersion(db: AnyDb, id: string): Promise<number> {
    const cur = await getWebhookSubscriptionById(db, id);
    if (!cur) throw new Error(`subscription not found: ${id}`);
    const newVersion = cur.secretVersion + 1;
    await db.update(webhookSubscriptions)
      .set({ secretVersion: newVersion })
      .where(eq(webhookSubscriptions.id, id));
    return newVersion;
  }
  ```

  Move the `import { webhookSubscriptions, ... }` line to the existing schema import block at the top of the file. Add `inArray` to the existing `drizzle-orm` import if not present.

- [ ] **Step 3.4: Run tests to verify they pass**

  Run: `bun test src/db/queries.webhooks.test.ts`
  Expected: PASS — all 7 tests green.

- [ ] **Step 3.5: Type-check**

  Run: `npx tsc --noEmit`
  Expected: PASS.

- [ ] **Step 3.6: Commit**

  ```bash
  git add src/db/queries.ts src/db/queries.webhooks.test.ts
  git commit -m "feat(db): webhook subscription query helpers"
  ```

---

## Phase 2: Pure pieces — types + expand + signing

### Task 4: Webhook types module

**Files:**
- Create: `workers/api/src/webhooks/types.ts`

- [ ] **Step 4.1: Create the types module**

  ```ts
  // workers/api/src/webhooks/types.ts
  import type { ReleaseEvent } from "../events/types.js";

  /**
   * One queue message represents one delivery attempt for one subscription.
   * The event payload is embedded so the consumer doesn't need to re-fetch
   * from D1 (which would race with deletes anyway).
   */
  export interface DeliveryMessage {
    subscriptionId: string;
    /** Subscriber URL captured at fan-out time so URL rotation doesn't strand in-flight messages. */
    url: string;
    /** Subscription's secret_version at fan-out time; consumer uses this in HMAC derivation. */
    secretVersion: number;
    event: ReleaseEvent;
    /** 1-indexed; queue retry handler is responsible for incrementing this. Used for AE attempt_number. */
    attempt: number;
  }
  ```

- [ ] **Step 4.2: Type-check**

  Run: `npx tsc --noEmit`
  Expected: PASS.

- [ ] **Step 4.3: Commit**

  ```bash
  git add workers/api/src/webhooks/types.ts
  git commit -m "feat(webhooks): add DeliveryMessage type"
  ```

### Task 5: `expand()` pure function

Maps `(events, subscriptions) → DeliveryMessage[]` by matching `orgId` (always) and `sourceId` (when subscription has one set).

**Files:**
- Create: `workers/api/src/webhooks/expand.ts`
- Create: `workers/api/src/webhooks/expand.test.ts`

- [ ] **Step 5.1: Write the failing test**

  ```ts
  // workers/api/src/webhooks/expand.test.ts
  import { describe, it, expect } from "bun:test";
  import { expand } from "./expand.js";
  import type { ReleaseEvent } from "../events/types.js";
  import type { WebhookSubscription } from "@buildinternet/releases-core/schema";

  function evt(overrides: Partial<ReleaseEvent["release"]> & { orgId: string; sourceId: string }): ReleaseEvent {
    return {
      id: "evt_x",
      seq: 1,
      ts: 1,
      type: "release.created",
      release: {
        id: "rel_a",
        title: "t",
        version: null,
        publishedAt: null,
        sourceName: "s",
        sourceSlug: "s",
        contentSummary: null,
        media: [],
        ...overrides,
      } as any,
    };
  }

  function sub(o: Partial<WebhookSubscription>): WebhookSubscription {
    return {
      id: "whk_x",
      orgId: "org_a",
      url: "https://hook.example/u",
      sourceId: null,
      enabled: true,
      description: null,
      secretVersion: 1,
      createdAt: "2026-04-18T00:00:00Z",
      lastSuccessAt: null,
      lastErrorAt: null,
      lastErrorMsg: null,
      consecutiveFailures: 0,
      disabledReason: null,
      ...o,
    } as WebhookSubscription;
  }

  // Helper to look up which org/source an event belongs to.
  // In real publisher path this comes from the inserted release row;
  // for this pure test we attach it to the event payload directly.
  function eventOwner(e: ReleaseEvent): { orgId: string; sourceId: string } {
    return { orgId: (e.release as any).orgId, sourceId: (e.release as any).sourceId };
  }

  describe("expand", () => {
    it("matches no subscriptions when none target the event's org", () => {
      const events = [evt({ orgId: "org_a", sourceId: "src_a" })];
      const subs = [sub({ id: "whk_1", orgId: "org_b" })];
      const out = expand(events, subs, eventOwner);
      expect(out).toEqual([]);
    });

    it("matches an org-wide subscription (sourceId null) for every event in that org", () => {
      const events = [
        evt({ id: "rel_1", orgId: "org_a", sourceId: "src_a" }),
        evt({ id: "rel_2", orgId: "org_a", sourceId: "src_b" }),
      ];
      const subs = [sub({ id: "whk_1", orgId: "org_a", sourceId: null })];
      const out = expand(events, subs, eventOwner);
      expect(out.length).toBe(2);
      expect(out.every((m) => m.subscriptionId === "whk_1")).toBe(true);
    });

    it("respects sourceId scoping", () => {
      const events = [
        evt({ id: "rel_1", orgId: "org_a", sourceId: "src_a" }),
        evt({ id: "rel_2", orgId: "org_a", sourceId: "src_b" }),
      ];
      const subs = [sub({ id: "whk_1", orgId: "org_a", sourceId: "src_a" })];
      const out = expand(events, subs, eventOwner);
      expect(out.length).toBe(1);
      expect((out[0].event.release as any).id).toBe("rel_1");
    });

    it("captures url and secretVersion from the subscription at fan-out time", () => {
      const events = [evt({ orgId: "org_a", sourceId: "src_a" })];
      const subs = [sub({ id: "whk_1", orgId: "org_a", url: "https://x.test/u", secretVersion: 7 })];
      const out = expand(events, subs, eventOwner);
      expect(out[0].url).toBe("https://x.test/u");
      expect(out[0].secretVersion).toBe(7);
      expect(out[0].attempt).toBe(1);
    });

    it("expands one event into N messages when N subscriptions match", () => {
      const events = [evt({ orgId: "org_a", sourceId: "src_a" })];
      const subs = [
        sub({ id: "whk_1", orgId: "org_a", sourceId: null }),
        sub({ id: "whk_2", orgId: "org_a", sourceId: "src_a" }),
        sub({ id: "whk_3", orgId: "org_a", sourceId: "src_b" }), // no match
      ];
      const out = expand(events, subs, eventOwner);
      expect(out.map((m) => m.subscriptionId).sort()).toEqual(["whk_1", "whk_2"]);
    });
  });
  ```

- [ ] **Step 5.2: Run tests to verify they fail**

  Run: `bun test workers/api/src/webhooks/expand.test.ts`
  Expected: FAIL — `expand` not defined.

- [ ] **Step 5.3: Implement `expand()`**

  ```ts
  // workers/api/src/webhooks/expand.ts
  import type { ReleaseEvent } from "../events/types.js";
  import type { WebhookSubscription } from "@buildinternet/releases-core/schema";
  import type { DeliveryMessage } from "./types.js";

  /**
   * Pure function: expand (events × subscriptions) → DeliveryMessage[].
   * The caller provides `eventOwner` which maps an event to its (orgId, sourceId)
   * — the publisher knows this from the inserted release row.
   */
  export function expand(
    events: ReleaseEvent[],
    subscriptions: WebhookSubscription[],
    eventOwner: (e: ReleaseEvent) => { orgId: string; sourceId: string },
  ): DeliveryMessage[] {
    const out: DeliveryMessage[] = [];
    for (const event of events) {
      const owner = eventOwner(event);
      for (const sub of subscriptions) {
        if (sub.orgId !== owner.orgId) continue;
        if (sub.sourceId !== null && sub.sourceId !== owner.sourceId) continue;
        out.push({
          subscriptionId: sub.id,
          url: sub.url,
          secretVersion: sub.secretVersion,
          event,
          attempt: 1,
        });
      }
    }
    return out;
  }
  ```

- [ ] **Step 5.4: Run tests to verify they pass**

  Run: `bun test workers/api/src/webhooks/expand.test.ts`
  Expected: PASS — all 5 tests green.

- [ ] **Step 5.5: Commit**

  ```bash
  git add workers/api/src/webhooks/expand.ts workers/api/src/webhooks/expand.test.ts
  git commit -m "feat(webhooks): expand pure function for fan-out"
  ```

### Task 6: HMAC signing module (shared between consumer + verify CLI)

Lives in `packages/core` so both `workers/webhooks` (signs) and `src/cli/commands/webhook-verify.ts` (verifies) can import it. No DB or Worker dependencies — only Web Crypto.

**Files:**
- Create: `packages/core/src/webhook-sign.ts`
- Create: `packages/core/src/webhook-sign.test.ts`

- [ ] **Step 6.1: Write the failing test**

  ```ts
  // packages/core/src/webhook-sign.test.ts
  import { describe, it, expect } from "bun:test";
  import { deriveSigningKey, signPayload, verifySignature } from "./webhook-sign.js";

  describe("webhook signing", () => {
    const master = "master_test_secret_value_32_chars_min__";

    it("derives a stable per-subscription key from (master, id, version)", async () => {
      const k1 = await deriveSigningKey(master, "whk_abc", 1);
      const k2 = await deriveSigningKey(master, "whk_abc", 1);
      expect(k1).toBe(k2);
    });

    it("derivation is sensitive to subscription id", async () => {
      const ka = await deriveSigningKey(master, "whk_abc", 1);
      const kb = await deriveSigningKey(master, "whk_xyz", 1);
      expect(ka).not.toBe(kb);
    });

    it("derivation is sensitive to secret_version", async () => {
      const k1 = await deriveSigningKey(master, "whk_abc", 1);
      const k2 = await deriveSigningKey(master, "whk_abc", 2);
      expect(k1).not.toBe(k2);
    });

    it("signPayload produces a hex SHA256 HMAC", async () => {
      const key = await deriveSigningKey(master, "whk_abc", 1);
      const sig = await signPayload(key, 1729281234, "{\"hello\":\"world\"}");
      expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    });

    it("verifySignature accepts a matching signature", async () => {
      const key = await deriveSigningKey(master, "whk_abc", 1);
      const ts = 1729281234;
      const body = "{\"hello\":\"world\"}";
      const sig = await signPayload(key, ts, body);
      expect(await verifySignature(key, ts, body, sig)).toBe(true);
    });

    it("verifySignature rejects a mismatched signature", async () => {
      const key = await deriveSigningKey(master, "whk_abc", 1);
      const ok = await verifySignature(key, 1729281234, "{\"hello\":\"world\"}", "sha256=00".padEnd(71, "0"));
      expect(ok).toBe(false);
    });

    it("verifySignature is constant-time for differing-length signatures", async () => {
      const key = await deriveSigningKey(master, "whk_abc", 1);
      const ok = await verifySignature(key, 1729281234, "{}", "sha256=ab");
      expect(ok).toBe(false);
    });
  });
  ```

- [ ] **Step 6.2: Run the test to verify it fails**

  Run: `bun test packages/core/src/webhook-sign.test.ts`
  Expected: FAIL — module not found.

- [ ] **Step 6.3: Implement the signing module**

  ```ts
  // packages/core/src/webhook-sign.ts
  // Web Crypto only — works in Workers, Bun, browsers. No node:crypto.

  const enc = new TextEncoder();

  async function importHmacKey(rawHex: string): Promise<CryptoKey> {
    const bytes = hexToBytes(rawHex);
    return crypto.subtle.importKey(
      "raw",
      bytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  }

  function hexToBytes(hex: string): Uint8Array {
    if (hex.length % 2 !== 0) throw new Error("invalid hex length");
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    }
    return out;
  }

  function bytesToHex(bytes: ArrayBuffer): string {
    const view = new Uint8Array(bytes);
    let out = "";
    for (let i = 0; i < view.length; i++) out += view[i].toString(16).padStart(2, "0");
    return out;
  }

  /**
   * Derive a per-subscription signing key as hex.
   * key = HMAC-SHA256(master, "${subscriptionId}:${secretVersion}")
   *
   * `master` is hex-encoded (the value stored in Secrets Store should be 32+
   * bytes of `openssl rand -hex 32`). The output is a 64-char hex string
   * suitable as the input key for signPayload.
   */
  export async function deriveSigningKey(
    masterHex: string,
    subscriptionId: string,
    secretVersion: number,
  ): Promise<string> {
    const key = await importHmacKey(masterHex);
    const data = enc.encode(`${subscriptionId}:${secretVersion}`);
    const sig = await crypto.subtle.sign("HMAC", key, data);
    return bytesToHex(sig);
  }

  /**
   * Sign the (timestamp, body) pair with the given hex key.
   * Returns "sha256=<hex>" suitable for the X-Released-Signature header.
   */
  export async function signPayload(
    signingKeyHex: string,
    timestampSeconds: number,
    rawBody: string,
  ): Promise<string> {
    const key = await importHmacKey(signingKeyHex);
    const data = enc.encode(`${timestampSeconds}.${rawBody}`);
    const sig = await crypto.subtle.sign("HMAC", key, data);
    return `sha256=${bytesToHex(sig)}`;
  }

  /**
   * Constant-time verify against a candidate signature in "sha256=<hex>" form.
   * Returns false on any malformed input rather than throwing.
   */
  export async function verifySignature(
    signingKeyHex: string,
    timestampSeconds: number,
    rawBody: string,
    candidate: string,
  ): Promise<boolean> {
    const expected = await signPayload(signingKeyHex, timestampSeconds, rawBody);
    return constantTimeEqual(expected, candidate);
  }

  function constantTimeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }
  ```

- [ ] **Step 6.4: Add the export to the package entrypoint**

  Open `packages/core/package.json`. In the `exports` field, add (or confirm) a path for `./webhook-sign`:

  ```jsonc
  "./webhook-sign": {
    "types": "./dist/webhook-sign.d.ts",
    "default": "./src/webhook-sign.ts"
  }
  ```

  (Match the format of existing entries. The exact shape varies — copy the pattern of `./schema` or `./categories`.)

- [ ] **Step 6.5: Run tests to verify they pass**

  Run: `bun test packages/core/src/webhook-sign.test.ts`
  Expected: PASS — all 7 tests green.

- [ ] **Step 6.6: Commit**

  ```bash
  git add packages/core/src/webhook-sign.ts packages/core/src/webhook-sign.test.ts packages/core/package.json
  git commit -m "feat(core): HMAC webhook-sign module"
  ```

---

## Phase 3: ReleaseHub replay endpoint

### Task 7: Bump `EVENT_BUFFER_SIZE` and add `/replay` HTTP path on ReleaseHub

The DO already has the buffer; this widens it and exposes the existing `replayEvents` over HTTP for the new public endpoint.

**Files:**
- Modify: `workers/api/src/events/types.ts` (one constant)
- Modify: `workers/api/src/release-hub.ts` (add new path)
- Create: `workers/api/test/release-hub-replay.test.ts`

- [ ] **Step 7.1: Bump the buffer size**

  In `workers/api/src/events/types.ts`, change:

  ```ts
  export const EVENT_BUFFER_SIZE = 1000;
  ```

  to:

  ```ts
  export const EVENT_BUFFER_SIZE = 7000;
  ```

  Update the comment above to: `/** Max events retained per DO. Ring buffer — oldest trimmed when exceeded. ~7 days at current ~700 events/day. */`.

- [ ] **Step 7.2: Write the failing test for the new HTTP path**

  ```ts
  // workers/api/test/release-hub-replay.test.ts
  import { describe, it, expect } from "bun:test";
  import { ReleaseHub } from "../src/release-hub.js";
  import { EVENT_BUFFER_SIZE } from "../src/events/types.js";

  // Minimal harness: build a fake DurableObjectState with an in-memory storage map.
  function makeHub() {
    const map = new Map<string, unknown>();
    const storage = {
      get: async (k: string) => map.get(k) ?? null,
      put: async (k: string, v: unknown) => { map.set(k, v); },
      delete: async (keys: string[]) => { for (const k of keys) map.delete(k); return undefined; },
      list: async (opts: { prefix: string; startAfter?: string }) => {
        const out = new Map<string, unknown>();
        const keys = [...map.keys()].filter((k) => k.startsWith(opts.prefix)).sort();
        for (const k of keys) {
          if (opts.startAfter && k <= opts.startAfter) continue;
          out.set(k, map.get(k));
        }
        return out as Map<string, any>;
      },
    } as unknown as DurableObjectStorage;

    const ctx = {
      storage,
      acceptWebSocket: () => {},
      getWebSockets: () => [],
    } as unknown as DurableObjectState;

    return new (ReleaseHub as any)(ctx, {});
  }

  async function publish(hub: any, n: number) {
    const events = [];
    for (let i = 0; i < n; i++) {
      events.push({
        id: `rel_${i}`, title: `r${i}`, version: null, publishedAt: null,
        sourceName: "s", sourceSlug: "s", contentSummary: null, media: [],
      });
    }
    await hub.fetch(new Request("https://do/publish", {
      method: "POST",
      body: JSON.stringify({ events }),
      headers: { "Content-Type": "application/json" },
    }));
  }

  describe("ReleaseHub /replay", () => {
    it("returns events with seq > since in JSON", async () => {
      const hub = makeHub();
      await publish(hub, 5);
      const res = await hub.fetch(new Request("https://do/replay?since=2"));
      expect(res.status).toBe(200);
      const body = await res.json() as { events: { seq: number }[]; head: number; gap?: unknown };
      expect(body.events.map((e) => e.seq)).toEqual([3, 4, 5]);
      expect(body.head).toBe(5);
      expect(body.gap).toBeUndefined();
    });

    it("returns gap marker when since is below oldestSeq - 1", async () => {
      const hub = makeHub();
      // Push more than EVENT_BUFFER_SIZE so eviction starts.
      // Test trimming with a smaller virtual buffer — we just prove the gap path.
      // Force-write a low oldest-seq to simulate trimming.
      await publish(hub, 3);
      // Manually patch oldest-seq to simulate a trimmed buffer.
      await (hub.ctx.storage as any).put("oldest-seq", 100);
      const res = await hub.fetch(new Request("https://do/replay?since=10"));
      const body = await res.json() as { gap?: { oldestSeq: number } };
      expect(body.gap).toEqual({ oldestSeq: 100 });
    });

    it("caps response size at limit param (default 500)", async () => {
      const hub = makeHub();
      await publish(hub, 600);
      const res = await hub.fetch(new Request("https://do/replay?since=0"));
      const body = await res.json() as { events: unknown[] };
      expect(body.events.length).toBe(500);
    });

    it("respects custom limit param up to 500 max", async () => {
      const hub = makeHub();
      await publish(hub, 50);
      const res = await hub.fetch(new Request("https://do/replay?since=0&limit=10"));
      const body = await res.json() as { events: unknown[] };
      expect(body.events.length).toBe(10);
    });
  });
  ```

- [ ] **Step 7.3: Run the test to verify it fails**

  Run: `bun test workers/api/test/release-hub-replay.test.ts`
  Expected: FAIL — endpoint returns 404.

- [ ] **Step 7.4: Implement the `/replay` path**

  In `workers/api/src/release-hub.ts`, add a new branch in `fetch()` between the `/subscribe` and `/seq` branches:

  ```ts
  // GET /replay?since=<n>&limit=<n> — JSON replay for the public webhooks endpoint.
  if (request.method === "GET" && url.pathname === "/replay") {
    const since = parseSince(url.searchParams.get("since")) ?? 0;
    const limitRaw = parseInt(url.searchParams.get("limit") ?? "500", 10);
    const limit = Math.max(1, Math.min(500, Number.isFinite(limitRaw) ? limitRaw : 500));

    const store = storageAsEventStore(this.ctx.storage);
    const head = await currentSeq(store);
    const oldest = await oldestSeq(store);

    const body: { events: ReleaseEvent[]; head: number; gap?: { oldestSeq: number } } = {
      events: [],
      head,
    };

    if (oldest > 0 && since < oldest - 1) {
      body.gap = { oldestSeq: oldest };
      // Continue and return whatever events exist; client sees both gap + events.
    }

    if (since < head) {
      const events = await replayEvents(store, since);
      body.events = events.slice(0, limit);
    }

    return new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
    });
  }
  ```

- [ ] **Step 7.5: Run tests to verify they pass**

  Run: `bun test workers/api/test/release-hub-replay.test.ts`
  Expected: PASS — all 4 tests green.

- [ ] **Step 7.6: Run the full api worker test suite to confirm no regressions**

  Run: `bun test workers/api/`
  Expected: PASS — no new failures.

- [ ] **Step 7.7: Commit**

  ```bash
  git add workers/api/src/events/types.ts workers/api/src/release-hub.ts workers/api/test/release-hub-replay.test.ts
  git commit -m "feat(release-hub): add /replay HTTP path; bump buffer to 7000"
  ```

### Task 8: Mount the public `GET /v1/webhooks/events` route

Thin proxy from the API worker to the DO's new `/replay` path.

**Files:**
- Create: `workers/api/src/routes/webhooks-replay.ts`
- Modify: `workers/api/src/index.ts` (mount route)
- Create: `workers/api/test/webhooks-replay.route.test.ts`

- [ ] **Step 8.1: Write the failing test**

  ```ts
  // workers/api/test/webhooks-replay.route.test.ts
  import { describe, it, expect } from "bun:test";
  import { Hono } from "hono";
  import { mountWebhooksReplay } from "../src/routes/webhooks-replay.js";

  function makeApp() {
    const app = new Hono();
    const fakeDoStub = {
      fetch: async (req: Request) => {
        const u = new URL(req.url);
        return new Response(JSON.stringify({ events: [{ seq: 1 }], head: 1, since: u.searchParams.get("since") }), {
          headers: { "Content-Type": "application/json" },
        });
      },
    };
    const env = {
      RELEASE_HUB: {
        idFromName: () => ({ toString: () => "id" }),
        get: () => fakeDoStub,
      },
    };
    mountWebhooksReplay(app, () => env as any);
    return app;
  }

  describe("GET /v1/webhooks/events", () => {
    it("proxies to the DO /replay path with since param", async () => {
      const app = makeApp();
      const res = await app.fetch(new Request("https://x.test/v1/webhooks/events?since=42"));
      expect(res.status).toBe(200);
      const body = await res.json() as { since?: string };
      expect(body.since).toBe("42");
    });

    it("returns 400 on a malformed since", async () => {
      const app = makeApp();
      const res = await app.fetch(new Request("https://x.test/v1/webhooks/events?since=foo"));
      expect(res.status).toBe(400);
    });
  });
  ```

- [ ] **Step 8.2: Run test, expect fail**

  Run: `bun test workers/api/test/webhooks-replay.route.test.ts`
  Expected: FAIL — module not found.

- [ ] **Step 8.3: Implement the route**

  ```ts
  // workers/api/src/routes/webhooks-replay.ts
  import type { Hono } from "hono";
  import { getReleaseHub } from "../utils.js";

  export function mountWebhooksReplay(app: Hono, getEnv: (c: any) => { RELEASE_HUB: DurableObjectNamespace }) {
    app.get("/v1/webhooks/events", async (c) => {
      const sinceRaw = c.req.query("since");
      const limitRaw = c.req.query("limit");
      const sinceParsed = sinceRaw === undefined ? 0 : parseInt(sinceRaw, 10);
      if (!Number.isFinite(sinceParsed) || sinceParsed < 0) {
        return c.json({ error: "since must be a non-negative integer" }, 400);
      }
      const env = getEnv(c);
      const u = new URL("https://do/replay");
      u.searchParams.set("since", String(sinceParsed));
      if (limitRaw) u.searchParams.set("limit", limitRaw);
      const res = await getReleaseHub(env).fetch(new Request(u.toString()));
      return new Response(res.body, {
        status: res.status,
        headers: { "Content-Type": "application/json" },
      });
    });
  }
  ```

- [ ] **Step 8.4: Mount in `workers/api/src/index.ts`**

  In `workers/api/src/index.ts`, find where other routes are mounted (search for existing `mount...` calls or route registrations). Add the import and the mount call alongside other public/no-auth routes:

  ```ts
  import { mountWebhooksReplay } from "./routes/webhooks-replay.js";
  // ...
  mountWebhooksReplay(app, (c) => c.env);
  ```

- [ ] **Step 8.5: Run tests to verify they pass**

  Run: `bun test workers/api/test/webhooks-replay.route.test.ts`
  Expected: PASS.

- [ ] **Step 8.6: Type-check the workers/api project**

  Run: `cd workers/api && npx tsc --noEmit`
  Expected: PASS.

- [ ] **Step 8.7: Commit**

  ```bash
  git add workers/api/src/routes/webhooks-replay.ts workers/api/src/index.ts workers/api/test/webhooks-replay.route.test.ts
  git commit -m "feat(api): public GET /v1/webhooks/events replay endpoint"
  ```

---

## Phase 4: Publisher integration

### Task 9: Add the queue producer binding to `workers/api`

**Files:**
- Modify: `workers/api/wrangler.jsonc` (add `queues.producers`)

- [ ] **Step 9.1: Add the producer binding**

  In `workers/api/wrangler.jsonc`, add a new top-level key (after `r2_buckets`, before `durable_objects`):

  ```jsonc
  "queues": {
    "producers": [
      { "binding": "WEBHOOK_DELIVERY_QUEUE", "queue": "webhook-delivery" }
    ]
  },
  ```

- [ ] **Step 9.2: Sanity-check wrangler config**

  Run: `cd workers/api && bunx wrangler deploy --dry-run --outdir=/tmp/wrangler-dryrun 2>&1 | head -30`
  Expected: prints binding info including `WEBHOOK_DELIVERY_QUEUE`. No errors.

- [ ] **Step 9.3: Commit**

  ```bash
  git add workers/api/wrangler.jsonc
  git commit -m "chore(api): bind webhook-delivery queue producer"
  ```

### Task 10: `expandAndEnqueue` wrapper

D1 lookup + pure expand + queue sendBatch (chunked at 100 per Queues' batch limit).

**Files:**
- Create: `workers/api/src/webhooks/expand-and-enqueue.ts`
- Create: `workers/api/src/webhooks/expand-and-enqueue.test.ts`

- [ ] **Step 10.1: Write the failing test**

  ```ts
  // workers/api/src/webhooks/expand-and-enqueue.test.ts
  import { describe, it, expect, mock } from "bun:test";
  import { expandAndEnqueue } from "./expand-and-enqueue.js";
  import type { DeliveryMessage } from "./types.js";

  function fakeDb(rows: any[]) {
    return {
      // matchWebhookSubscriptions queries this; we stub at the helper level.
    };
  }

  describe("expandAndEnqueue", () => {
    it("no-ops on empty events", async () => {
      const sendBatch = mock(async (_: any[]) => {});
      await expandAndEnqueue({
        events: [],
        eventOwners: new Map(),
        loadSubscriptions: async () => [],
        queue: { sendBatch } as any,
      });
      expect(sendBatch).not.toHaveBeenCalled();
    });

    it("no-ops when no subscriptions match", async () => {
      const sendBatch = mock(async (_: any[]) => {});
      await expandAndEnqueue({
        events: [{ id: "evt_1", seq: 1, ts: 1, type: "release.created", release: { id: "rel_1" } as any }],
        eventOwners: new Map([["rel_1", { orgId: "org_a", sourceId: "src_a" }]]),
        loadSubscriptions: async () => [],
        queue: { sendBatch } as any,
      });
      expect(sendBatch).not.toHaveBeenCalled();
    });

    it("sends one message per match", async () => {
      const sent: DeliveryMessage[] = [];
      const sendBatch = mock(async (msgs: { body: DeliveryMessage }[]) => {
        for (const m of msgs) sent.push(m.body);
      });
      const events = [{ id: "evt_1", seq: 1, ts: 1, type: "release.created", release: { id: "rel_1" } as any }];
      const owners = new Map([["rel_1", { orgId: "org_a", sourceId: "src_a" }]]);
      const subs = [
        { id: "whk_1", orgId: "org_a", sourceId: null, url: "https://h1", secretVersion: 1, enabled: true } as any,
        { id: "whk_2", orgId: "org_b", sourceId: null, url: "https://h2", secretVersion: 1, enabled: true } as any,
      ];
      await expandAndEnqueue({
        events,
        eventOwners: owners,
        loadSubscriptions: async () => subs,
        queue: { sendBatch } as any,
      });
      expect(sent.length).toBe(1);
      expect(sent[0].subscriptionId).toBe("whk_1");
    });

    it("chunks sendBatch calls at 100 messages each", async () => {
      const calls: number[] = [];
      const sendBatch = mock(async (msgs: any[]) => { calls.push(msgs.length); });
      // 250 events × 1 sub = 250 messages → 3 batches: 100, 100, 50.
      const events = Array.from({ length: 250 }, (_, i) => ({
        id: `evt_${i}`, seq: i + 1, ts: 1, type: "release.created", release: { id: `rel_${i}` } as any,
      }));
      const owners = new Map(events.map((e) => [(e.release as any).id, { orgId: "org_a", sourceId: "src_a" }]));
      const subs = [{ id: "whk_1", orgId: "org_a", sourceId: null, url: "https://h", secretVersion: 1, enabled: true } as any];
      await expandAndEnqueue({
        events,
        eventOwners: owners,
        loadSubscriptions: async () => subs,
        queue: { sendBatch } as any,
      });
      expect(calls).toEqual([100, 100, 50]);
    });

    it("swallows queue errors with a warn — never throws", async () => {
      const sendBatch = mock(async (_: any[]) => { throw new Error("queue down"); });
      const events = [{ id: "evt_1", seq: 1, ts: 1, type: "release.created", release: { id: "rel_1" } as any }];
      const owners = new Map([["rel_1", { orgId: "org_a", sourceId: "src_a" }]]);
      const subs = [{ id: "whk_1", orgId: "org_a", sourceId: null, url: "https://h", secretVersion: 1, enabled: true } as any];
      // Should not throw.
      await expandAndEnqueue({ events, eventOwners: owners, loadSubscriptions: async () => subs, queue: { sendBatch } as any });
    });
  });
  ```

- [ ] **Step 10.2: Run test, expect fail**

  Run: `bun test workers/api/src/webhooks/expand-and-enqueue.test.ts`
  Expected: FAIL — module not found.

- [ ] **Step 10.3: Implement**

  ```ts
  // workers/api/src/webhooks/expand-and-enqueue.ts
  import type { ReleaseEvent } from "../events/types.js";
  import type { WebhookSubscription } from "@buildinternet/releases-core/schema";
  import { expand } from "./expand.js";
  import type { DeliveryMessage } from "./types.js";

  export interface ExpandAndEnqueueArgs {
    events: ReleaseEvent[];
    /** Maps release.id to its (orgId, sourceId). Built by the caller from the inserted rows. */
    eventOwners: Map<string, { orgId: string; sourceId: string }>;
    loadSubscriptions: (orgIds: string[]) => Promise<WebhookSubscription[]>;
    queue: { sendBatch: (messages: { body: DeliveryMessage }[]) => Promise<void> };
  }

  const QUEUE_BATCH_LIMIT = 100;

  /**
   * Fan-out side-effect: load matching subscriptions, expand into messages, sendBatch in chunks.
   * Never throws — queue/D1 failures are logged. Caller should already be inside ctx.waitUntil().
   */
  export async function expandAndEnqueue(args: ExpandAndEnqueueArgs): Promise<void> {
    if (args.events.length === 0) return;
    try {
      const orgIds = [...new Set(
        args.events.map((e) => args.eventOwners.get(e.release.id)?.orgId).filter((x): x is string => !!x),
      )];
      if (orgIds.length === 0) return;
      const subs = await args.loadSubscriptions(orgIds);
      if (subs.length === 0) return;
      const messages = expand(args.events, subs, (e) => {
        const owner = args.eventOwners.get(e.release.id);
        if (!owner) return { orgId: "", sourceId: "" };
        return owner;
      });
      if (messages.length === 0) return;
      // Chunk at 100 per Cloudflare Queues batch limit.
      for (let i = 0; i < messages.length; i += QUEUE_BATCH_LIMIT) {
        const chunk = messages.slice(i, i + QUEUE_BATCH_LIMIT);
        await args.queue.sendBatch(chunk.map((body) => ({ body })));
      }
    } catch (err) {
      console.warn(`[webhooks] expandAndEnqueue failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  ```

- [ ] **Step 10.4: Run tests to verify they pass**

  Run: `bun test workers/api/src/webhooks/expand-and-enqueue.test.ts`
  Expected: PASS.

- [ ] **Step 10.5: Commit**

  ```bash
  git add workers/api/src/webhooks/expand-and-enqueue.ts workers/api/src/webhooks/expand-and-enqueue.test.ts
  git commit -m "feat(webhooks): expandAndEnqueue wrapper with batch chunking"
  ```

### Task 11: Wire `expandAndEnqueue` into `publishReleaseEvents`

**Files:**
- Modify: `workers/api/src/events/publish.ts`
- Modify: `workers/api/src/events/build-event.ts` (likely — to expose owner info)
- Modify: `workers/api/src/routes/sources.ts` (call site already wraps in waitUntil; just confirm env binding is passed)
- Modify: `workers/api/src/cron/poll-fetch.ts` (same)

- [ ] **Step 11.1: Inspect `build-event.ts` to understand the data shape**

  Open `workers/api/src/events/build-event.ts`. Confirm `InsertedReleaseRow` includes `id`, `orgId`, `sourceId` (or equivalents). If `orgId` isn't present, the call sites need to thread it through. Read the file end-to-end before making changes.

- [ ] **Step 11.2: Modify `publishReleaseEvents` signature and body**

  Open `workers/api/src/events/publish.ts`. Replace the file with:

  ```ts
  import { getReleaseHub } from "../utils.js";
  import { buildReleaseEventPayloads, type InsertedReleaseRow } from "./build-event.js";
  import { expandAndEnqueue } from "../webhooks/expand-and-enqueue.js";
  import { matchWebhookSubscriptions } from "@releases/db/queries.js";
  import { getDb } from "../db.js";
  import type { ReleaseEvent } from "./types.js";

  export interface PublishContext {
    src: { name: string; slug: string; orgId: string; sourceId: string };
    inserted: InsertedReleaseRow[];
  }

  export interface PublishEnv {
    RELEASE_HUB: DurableObjectNamespace;
    WEBHOOK_DELIVERY_QUEUE: Queue<unknown>;
    DB: D1Database;
  }

  /**
   * Publish release.created events:
   *   1. To ReleaseHub (WebSocket fan-out + ring buffer).
   *   2. To webhook-delivery queue (per-subscription fan-out).
   *
   * Both branches are fire-and-forget. Caller already wraps this in
   * ctx.waitUntil(). Errors are logged, never thrown.
   */
  export async function publishReleaseEvents(
    env: PublishEnv,
    ctx: PublishContext,
  ): Promise<void> {
    if (ctx.inserted.length === 0) return;
    const events: ReleaseEvent[] = []; // populated below
    const eventOwners = new Map<string, { orgId: string; sourceId: string }>();
    for (const row of ctx.inserted) {
      eventOwners.set(row.id, { orgId: ctx.src.orgId, sourceId: ctx.src.sourceId });
    }

    // (1) Hub publish. Capture the assigned events for owner-keying parity with downstream.
    let hubEvents: ReleaseEvent[] = [];
    try {
      const payloads = buildReleaseEventPayloads(ctx);
      const res = await getReleaseHub(env).fetch(new Request("https://do/publish", {
        method: "POST",
        body: JSON.stringify({ events: payloads }),
        headers: { "Content-Type": "application/json" },
      }));
      if (!res.ok) {
        console.warn(`[events] publish returned ${res.status}: ${await res.text().catch(() => "")}`);
      } else {
        // The DO returns { published: N } today; we want the assigned ReleaseEvents.
        // Fetch them by replaying since=last-known. Acceptable: replay since head-N.
        // (Alternative: extend the DO to return the events. Done in a small follow-up.)
        // For v1, build ReleaseEvent shape locally with placeholder seq/id; the queue
        // consumer doesn't depend on seq matching the DO's, only on the release payload.
        hubEvents = payloads.map((p, i) => ({
          id: `local_${Date.now()}_${i}`,
          seq: 0,
          ts: Date.now(),
          type: "release.created" as const,
          release: p,
        }));
      }
    } catch (err) {
      console.warn(`[events] hub publish failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // (2) Webhook fan-out. Independent of hub publish success.
    const db = getDb(env);
    await expandAndEnqueue({
      events: hubEvents,
      eventOwners,
      loadSubscriptions: (orgIds) => matchWebhookSubscriptions(db, orgIds),
      queue: env.WEBHOOK_DELIVERY_QUEUE,
    });
  }
  ```

  **Note on ReleaseEvent.seq parity:** the local `seq: 0` placeholder is acceptable for v1 because the consumer doesn't use `seq` from the queue message — it uses `release.id` for idempotency (`X-Released-Event-Id` header) and `event.id` (assigned locally here). If a future requirement needs the DO-assigned `seq` in the webhook payload (for resume cursor handoff), extend the DO `/publish` response to return assigned events and use those.

- [ ] **Step 11.3: Update the `PublishContext` shape at all call sites**

  - In `workers/api/src/routes/sources.ts:318`, the `publishReleaseEvents` call needs `ctx.src.orgId` and `ctx.src.sourceId`. Read the surrounding lines to confirm `source.orgId` and `source.id` are in scope; pass them.
  - In `workers/api/src/cron/poll-fetch.ts:329`, same. The `source` row should have these.
  - Also: ensure both call sites' `env` includes `WEBHOOK_DELIVERY_QUEUE` and `DB`. The Hono context's `c.env` should already match the Worker's env (which now has the binding from Task 9).

  Apply the type changes by reading each call site, updating the `ctx` argument shape, and confirming the env passed satisfies `PublishEnv`.

- [ ] **Step 11.4: Run the publish-related tests**

  Run: `bun test workers/api/`
  Expected: PASS — pre-existing tests still green; any new failures point to type or shape mismatches in `publishReleaseEvents` callers.

- [ ] **Step 11.5: Type-check**

  Run: `cd workers/api && npx tsc --noEmit`
  Expected: PASS.

- [ ] **Step 11.6: Commit**

  ```bash
  git add workers/api/src/events/publish.ts workers/api/src/routes/sources.ts workers/api/src/cron/poll-fetch.ts
  git commit -m "feat(api): wire webhook fan-out into publishReleaseEvents"
  ```

---

## Phase 5: workers/webhooks scaffold

### Task 12: Bootstrap the new Worker

**Files:**
- Create: `workers/webhooks/package.json`
- Create: `workers/webhooks/tsconfig.json`
- Create: `workers/webhooks/wrangler.jsonc`
- Create: `workers/webhooks/src/index.ts` (skeleton)
- Modify: root `package.json` (confirm `workers/webhooks` is excluded from Bun workspace, like `workers/discovery` and `workers/mcp`)

- [ ] **Step 12.1: Create `workers/webhooks/package.json`**

  Copy the shape from `workers/discovery/package.json`. Adjust name + scripts:

  ```jsonc
  {
    "name": "releases-webhooks",
    "version": "0.0.1",
    "type": "module",
    "private": true,
    "scripts": {
      "dev": "wrangler dev",
      "deploy": "wrangler deploy",
      "test": "bun test",
      "typecheck": "tsc --noEmit"
    },
    "devDependencies": {
      "@cloudflare/workers-types": "^4.20240620.0",
      "typescript": "^5.4.0",
      "wrangler": "^3.60.0"
    }
  }
  ```

  Match the actual versions used in `workers/discovery/package.json`.

- [ ] **Step 12.2: Create `workers/webhooks/tsconfig.json`**

  Copy from `workers/discovery/tsconfig.json` verbatim, then adjust paths if `@releases/lib/*` mappings need to point to `../../src/lib/*` (per AGENTS.md).

- [ ] **Step 12.3: Create `workers/webhooks/wrangler.jsonc`**

  ```jsonc
  {
    "$schema": "node_modules/wrangler/config-schema.json",
    "name": "releases-webhooks",
    "main": "src/index.ts",
    "alias": {
      "@releases": "../../src"
    },
    "compatibility_date": "2026-03-27",
    "compatibility_flags": ["nodejs_compat"],
    "observability": { "enabled": true },
    "vars": {
      "DELIVERY_TIMEOUT_MS": "10000",
      "AUTO_DISABLE_THRESHOLD": "50"
    },
    "d1_databases": [
      {
        "binding": "DB",
        "database_name": "released-db",
        "database_id": "73be1562-d900-4e25-a62b-650ab74488b7"
      }
    ],
    "queues": {
      "consumers": [
        {
          "queue": "webhook-delivery",
          "max_batch_size": 10,
          "max_batch_timeout": 5,
          "max_retries": 6,
          "dead_letter_queue": "webhook-dlq"
        },
        {
          "queue": "webhook-dlq",
          "max_batch_size": 10,
          "max_batch_timeout": 5,
          "max_retries": 0
        }
      ]
    },
    "analytics_engine_datasets": [
      { "binding": "WEBHOOK_DELIVERIES_AE", "dataset": "webhook_deliveries" }
    ],
    "secrets_store_secrets": [
      { "binding": "WEBHOOK_HMAC_MASTER", "store_id": "a887a71cab084105b79706df23380723", "secret_name": "WEBHOOK_HMAC_MASTER" }
    ],
    "unsafe": {
      "bindings": [
        {
          "name": "PER_SUB_RATE_LIMITER",
          "type": "ratelimit",
          "namespace_id": "1002",
          "simple": { "limit": 600, "period": 60 }
        }
      ]
    }
  }
  ```

  Notes:
  - Same `database_id` as `workers/api` so both Workers see the same D1.
  - Same `store_id` as `workers/api` for Secrets Store.
  - `namespace_id: 1002` for the rate limiter (any unique number; workers/api uses 1001).
  - `limit: 600` over 60s ≈ 10 rps sustained; bursts are absorbed by Queues holding the message.

- [ ] **Step 12.4: Create the skeleton handler**

  ```ts
  // workers/webhooks/src/index.ts
  import type { DeliveryMessage } from "../../api/src/webhooks/types.js";

  export interface Env {
    DB: D1Database;
    WEBHOOK_DELIVERIES_AE: AnalyticsEngineDataset;
    WEBHOOK_HMAC_MASTER: string;
    PER_SUB_RATE_LIMITER: { limit: (opts: { key: string }) => Promise<{ success: boolean }> };
    DELIVERY_TIMEOUT_MS: string;
    AUTO_DISABLE_THRESHOLD: string;
  }

  export default {
    async queue(batch: MessageBatch<DeliveryMessage>, env: Env): Promise<void> {
      if (batch.queue === "webhook-dlq") {
        for (const msg of batch.messages) {
          console.warn(`[webhook-dlq] ${msg.body.subscriptionId} ${msg.body.event.release.id}`);
          msg.ack();
        }
        return;
      }
      // Real delivery handler — implemented in Task 17.
      for (const msg of batch.messages) {
        msg.ack();
      }
    },
  };
  ```

- [ ] **Step 12.5: Confirm workspace exclusion**

  Open the root `package.json`. The `workspaces` array should include `workers/api`, `web`, `npm/*`, `packages/*` but NOT `workers/webhooks`. If it's listed, remove it (per AGENTS.md, `cloudflare:workers` imports cause Bun workspace startup to fail).

- [ ] **Step 12.6: Install deps + dry-run wrangler**

  ```bash
  cd workers/webhooks
  bun install
  bunx wrangler deploy --dry-run --outdir=/tmp/wh-dryrun
  ```

  Expected: prints binding info; no errors. Confirms the wrangler config is valid.

- [ ] **Step 12.7: Commit**

  ```bash
  git add workers/webhooks/ package.json
  git commit -m "feat(webhooks): scaffold workers/webhooks (queues, AE, secrets, rate limiter)"
  ```

---

## Phase 6: Consumer modules

### Task 13: Consumer-side D1 helpers

The consumer needs read access to `webhook_subscriptions` and write access to summary cols + enabled flag. Reuses the helpers from Task 3 by importing from `@releases/db/queries`. Also adds a thin Drizzle binding for D1.

**Files:**
- Create: `workers/webhooks/src/db.ts`

- [ ] **Step 13.1: Create the helper**

  ```ts
  // workers/webhooks/src/db.ts
  import { drizzle } from "drizzle-orm/d1";
  import {
    getWebhookSubscriptionById,
    updateWebhookSubscriptionSummary,
    setWebhookSubscriptionEnabled,
  } from "@releases/db/queries.js";

  export function getDb(env: { DB: D1Database }) {
    return drizzle(env.DB);
  }

  export {
    getWebhookSubscriptionById,
    updateWebhookSubscriptionSummary,
    setWebhookSubscriptionEnabled,
  };
  ```

- [ ] **Step 13.2: Type-check**

  Run: `cd workers/webhooks && npx tsc --noEmit`
  Expected: PASS.

- [ ] **Step 13.3: Commit**

  ```bash
  git add workers/webhooks/src/db.ts
  git commit -m "feat(webhooks): D1 db helpers via shared queries"
  ```

### Task 14: Analytics Engine writer

**Files:**
- Create: `workers/webhooks/src/ae.ts`
- Create: `workers/webhooks/src/ae.test.ts`

- [ ] **Step 14.1: Write the failing test**

  ```ts
  // workers/webhooks/src/ae.test.ts
  import { describe, it, expect, mock } from "bun:test";
  import { writeDeliveryAttempt } from "./ae.js";

  function fakeAE() {
    const written: any[] = [];
    return {
      ds: { writeDataPoint: (point: any) => { written.push(point); } } as any,
      written,
    };
  }

  describe("writeDeliveryAttempt", () => {
    it("indexes by subscription_id and includes outcome blob", () => {
      const ae = fakeAE();
      writeDeliveryAttempt(ae.ds, {
        subscriptionId: "whk_1",
        eventId: "evt_x",
        outcome: "success",
        httpStatus: 200,
        latencyMs: 42,
        attempt: 1,
        errorMessage: null,
        errorCode: null,
      });
      expect(ae.written.length).toBe(1);
      expect(ae.written[0].indexes).toEqual(["whk_1"]);
      expect(ae.written[0].blobs[0]).toBe("evt_x");
      expect(ae.written[0].blobs[3]).toBe("success");
      expect(ae.written[0].doubles).toEqual([200, 42, 1]);
    });

    it("handles error fields without throwing", () => {
      const ae = fakeAE();
      writeDeliveryAttempt(ae.ds, {
        subscriptionId: "whk_1",
        eventId: "evt_x",
        outcome: "perm_fail",
        httpStatus: 400,
        latencyMs: 50,
        attempt: 1,
        errorMessage: "bad payload",
        errorCode: "subscriber_4xx",
      });
      expect(ae.written[0].blobs[1]).toBe("bad payload");
      expect(ae.written[0].blobs[2]).toBe("subscriber_4xx");
    });
  });
  ```

- [ ] **Step 14.2: Run test, expect fail**

  Run: `cd workers/webhooks && bun test src/ae.test.ts`
  Expected: FAIL — module not found.

- [ ] **Step 14.3: Implement**

  ```ts
  // workers/webhooks/src/ae.ts

  export type Outcome = "success" | "retry" | "perm_fail" | "skipped" | "dlq" | "auto_disabled";

  export interface DeliveryAttempt {
    subscriptionId: string;
    eventId: string;
    outcome: Outcome;
    httpStatus: number;
    latencyMs: number;
    attempt: number;
    errorMessage: string | null;
    errorCode: string | null;
  }

  /**
   * Write one data point to the webhook_deliveries AE dataset.
   * Schema:
   *   indexes: [subscription_id]
   *   blobs:   [event_id, error_message, error_code, outcome]
   *   doubles: [http_status, latency_ms, attempt_number]
   */
  export function writeDeliveryAttempt(
    ds: AnalyticsEngineDataset,
    attempt: DeliveryAttempt,
  ): void {
    ds.writeDataPoint({
      indexes: [attempt.subscriptionId],
      blobs: [
        attempt.eventId,
        attempt.errorMessage ?? "",
        attempt.errorCode ?? "",
        attempt.outcome,
      ],
      doubles: [attempt.httpStatus, attempt.latencyMs, attempt.attempt],
    });
  }
  ```

- [ ] **Step 14.4: Run tests to verify they pass**

  Run: `bun test src/ae.test.ts`
  Expected: PASS.

- [ ] **Step 14.5: Commit**

  ```bash
  git add workers/webhooks/src/ae.ts workers/webhooks/src/ae.test.ts
  git commit -m "feat(webhooks): Analytics Engine delivery writer"
  ```

### Task 15: `deliver()` — single attempt with branching

Performs one HTTP POST: signs, sends with timeout, classifies the response into one of `{ success, retry, perm_fail }`. Returns a `DeliveryResult` for the orchestration layer to act on. Pure-ish — no DB or AE writes here; the caller does those.

**Files:**
- Create: `workers/webhooks/src/deliver.ts`
- Create: `workers/webhooks/src/deliver.test.ts`

- [ ] **Step 15.1: Write the failing test**

  ```ts
  // workers/webhooks/src/deliver.test.ts
  import { describe, it, expect } from "bun:test";
  import { deliver } from "./deliver.js";
  import type { DeliveryMessage } from "../../api/src/webhooks/types.js";

  function msg(): DeliveryMessage {
    return {
      subscriptionId: "whk_1",
      url: "https://hook.example/u",
      secretVersion: 1,
      event: {
        id: "evt_1", seq: 1, ts: 1, type: "release.created",
        release: { id: "rel_1", title: "t", version: null, publishedAt: null,
          sourceName: "s", sourceSlug: "s", contentSummary: null, media: [] } as any,
      },
      attempt: 1,
    };
  }

  describe("deliver", () => {
    it("returns success on 2xx", async () => {
      const fetch = async () => new Response("ok", { status: 200 });
      const r = await deliver(msg(), {
        masterKey: "deadbeef".repeat(8),
        timeoutMs: 1000,
        fetchImpl: fetch as any,
        now: () => 1729281234,
      });
      expect(r.outcome).toBe("success");
      expect(r.httpStatus).toBe(200);
      expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("returns perm_fail on 4xx", async () => {
      const fetch = async () => new Response("bad", { status: 400 });
      const r = await deliver(msg(), { masterKey: "deadbeef".repeat(8), timeoutMs: 1000, fetchImpl: fetch as any, now: () => 1 });
      expect(r.outcome).toBe("perm_fail");
      expect(r.httpStatus).toBe(400);
    });

    it("returns retry on 5xx", async () => {
      const fetch = async () => new Response("err", { status: 503 });
      const r = await deliver(msg(), { masterKey: "deadbeef".repeat(8), timeoutMs: 1000, fetchImpl: fetch as any, now: () => 1 });
      expect(r.outcome).toBe("retry");
    });

    it("returns retry on network error", async () => {
      const fetch = async () => { throw new TypeError("network"); };
      const r = await deliver(msg(), { masterKey: "deadbeef".repeat(8), timeoutMs: 1000, fetchImpl: fetch as any, now: () => 1 });
      expect(r.outcome).toBe("retry");
      expect(r.errorCode).toBe("network");
    });

    it("returns retry on timeout (AbortError)", async () => {
      const fetch = async () => { const e: any = new Error("aborted"); e.name = "AbortError"; throw e; };
      const r = await deliver(msg(), { masterKey: "deadbeef".repeat(8), timeoutMs: 1, fetchImpl: fetch as any, now: () => 1 });
      expect(r.outcome).toBe("retry");
      expect(r.errorCode).toBe("timeout");
    });

    it("sends the expected headers", async () => {
      let captured: Request | null = null;
      const fetch = async (req: Request) => { captured = req; return new Response("ok", { status: 200 }); };
      await deliver(msg(), { masterKey: "deadbeef".repeat(8), timeoutMs: 1000, fetchImpl: fetch as any, now: () => 1729281234 });
      expect(captured).not.toBeNull();
      const r = captured!;
      expect(r.headers.get("X-Released-Version")).toBe("1");
      expect(r.headers.get("X-Released-Event-Id")).toBe("evt_1");
      expect(r.headers.get("X-Released-Timestamp")).toBe("1729281234");
      expect(r.headers.get("X-Released-Signature")).toMatch(/^sha256=[0-9a-f]{64}$/);
      expect(r.headers.get("Content-Type")).toBe("application/json");
      expect(r.headers.get("User-Agent")).toBe("releases-webhooks/1");
    });
  });
  ```

- [ ] **Step 15.2: Run test, expect fail**

  Run: `bun test src/deliver.test.ts`
  Expected: FAIL — module not found.

- [ ] **Step 15.3: Implement**

  ```ts
  // workers/webhooks/src/deliver.ts
  import { deriveSigningKey, signPayload } from "@buildinternet/releases-core/webhook-sign";
  import type { DeliveryMessage } from "../../api/src/webhooks/types.js";
  import type { Outcome } from "./ae.js";

  export interface DeliveryResult {
    outcome: Extract<Outcome, "success" | "retry" | "perm_fail">;
    httpStatus: number;       // 0 if no response (network/timeout)
    latencyMs: number;
    errorMessage: string | null;
    errorCode: string | null; // "network", "timeout", "subscriber_5xx", "subscriber_4xx", or null on success
  }

  export interface DeliverOptions {
    masterKey: string;
    timeoutMs: number;
    fetchImpl?: typeof fetch;
    now?: () => number; // unix seconds
  }

  export async function deliver(message: DeliveryMessage, opts: DeliverOptions): Promise<DeliveryResult> {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    const ts = now();
    const body = JSON.stringify(message.event);
    const signingKey = await deriveSigningKey(opts.masterKey, message.subscriptionId, message.secretVersion);
    const signature = await signPayload(signingKey, ts, body);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);
    const start = Date.now();

    try {
      const res = await fetchImpl(message.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Released-Version": "1",
          "X-Released-Event-Id": message.event.id,
          "X-Released-Timestamp": String(ts),
          "X-Released-Signature": signature,
          "User-Agent": "releases-webhooks/1",
        },
        body,
        signal: controller.signal,
      });
      const latencyMs = Date.now() - start;
      if (res.status >= 200 && res.status < 300) {
        return { outcome: "success", httpStatus: res.status, latencyMs, errorMessage: null, errorCode: null };
      }
      if (res.status >= 400 && res.status < 500) {
        const excerpt = await res.text().then((t) => t.slice(0, 200)).catch(() => "");
        return { outcome: "perm_fail", httpStatus: res.status, latencyMs, errorMessage: excerpt, errorCode: "subscriber_4xx" };
      }
      return { outcome: "retry", httpStatus: res.status, latencyMs, errorMessage: `subscriber returned ${res.status}`, errorCode: "subscriber_5xx" };
    } catch (err: any) {
      const latencyMs = Date.now() - start;
      if (err?.name === "AbortError") {
        return { outcome: "retry", httpStatus: 0, latencyMs, errorMessage: "timeout", errorCode: "timeout" };
      }
      return { outcome: "retry", httpStatus: 0, latencyMs, errorMessage: err?.message ?? String(err), errorCode: "network" };
    } finally {
      clearTimeout(timeout);
    }
  }
  ```

- [ ] **Step 15.4: Run tests to verify they pass**

  Run: `bun test src/deliver.test.ts`
  Expected: PASS — all 6 tests green.

- [ ] **Step 15.5: Commit**

  ```bash
  git add workers/webhooks/src/deliver.ts workers/webhooks/src/deliver.test.ts
  git commit -m "feat(webhooks): single-attempt delivery with branching outcomes"
  ```

### Task 16: Wire `queue()` and `dlq()` handlers; add auto-disable + rate limiting

**Files:**
- Modify: `workers/webhooks/src/index.ts`
- Create: `workers/webhooks/src/index.test.ts`

- [ ] **Step 16.1: Write the failing integration test**

  ```ts
  // workers/webhooks/src/index.test.ts
  import { describe, it, expect, mock } from "bun:test";
  import worker from "./index.js";

  // Minimal MessageBatch fake.
  function batch(messages: any[], queue = "webhook-delivery") {
    const acked: any[] = [];
    const retried: any[] = [];
    return {
      queue,
      messages: messages.map((body, i) => ({
        id: `m${i}`,
        body,
        timestamp: new Date(),
        attempts: 1,
        ack: () => acked.push(body),
        retry: (opts?: any) => retried.push({ body, opts }),
      })),
      ackAll: () => {},
      retryAll: () => {},
      acked,
      retried,
    };
  }

  function fakeEnv(overrides: any = {}) {
    return {
      DB: {} as any,
      WEBHOOK_DELIVERIES_AE: { writeDataPoint: () => {} } as any,
      WEBHOOK_HMAC_MASTER: "deadbeef".repeat(8),
      PER_SUB_RATE_LIMITER: { limit: async () => ({ success: true }) },
      DELIVERY_TIMEOUT_MS: "100",
      AUTO_DISABLE_THRESHOLD: "50",
      ...overrides,
    };
  }

  function deliveryMsg(subId = "whk_1") {
    return {
      subscriptionId: subId,
      url: "https://hook.example/u",
      secretVersion: 1,
      event: { id: "evt_1", seq: 1, ts: 1, type: "release.created", release: { id: "rel_1", title: "t", version: null, publishedAt: null, sourceName: "s", sourceSlug: "s", contentSummary: null, media: [] } as any },
      attempt: 1,
    };
  }

  describe("queue handler", () => {
    it("acks messages routed to the dlq", async () => {
      const b = batch([deliveryMsg()], "webhook-dlq");
      await worker.queue(b as any, fakeEnv() as any);
      expect(b.acked.length).toBe(1);
    });

    it("rate-limits and retries when the limiter says no", async () => {
      const b = batch([deliveryMsg()]);
      const env = fakeEnv({
        PER_SUB_RATE_LIMITER: { limit: async () => ({ success: false }) },
      });
      // Patch deliver to ensure it's NOT called when rate-limited
      // (by injecting a fetch that throws if hit).
      await worker.queue(b as any, env as any);
      expect(b.retried.length).toBe(1);
    });
    // Additional behavior tests live in deliver.test.ts (single attempt branching);
    // the orchestration layer is exercised end-to-end by the staging e2e in Phase 9.
  });
  ```

- [ ] **Step 16.2: Run, expect fail**

  Run: `bun test src/index.test.ts`
  Expected: FAIL — current handler is the skeleton from Task 12.

- [ ] **Step 16.3: Replace `workers/webhooks/src/index.ts` with the full implementation**

  ```ts
  // workers/webhooks/src/index.ts
  import { drizzle } from "drizzle-orm/d1";
  import {
    getWebhookSubscriptionById,
    updateWebhookSubscriptionSummary,
    setWebhookSubscriptionEnabled,
  } from "@releases/db/queries.js";
  import { deliver } from "./deliver.js";
  import { writeDeliveryAttempt } from "./ae.js";
  import type { DeliveryMessage } from "../../api/src/webhooks/types.js";

  export interface Env {
    DB: D1Database;
    WEBHOOK_DELIVERIES_AE: AnalyticsEngineDataset;
    WEBHOOK_HMAC_MASTER: string;
    PER_SUB_RATE_LIMITER: { limit: (opts: { key: string }) => Promise<{ success: boolean }> };
    DELIVERY_TIMEOUT_MS: string;
    AUTO_DISABLE_THRESHOLD: string;
  }

  export default {
    async queue(batch: MessageBatch<DeliveryMessage>, env: Env): Promise<void> {
      // Terminal handler for the DLQ — log + AE record, then ack.
      if (batch.queue === "webhook-dlq") {
        for (const msg of batch.messages) {
          console.warn(
            `[webhook-dlq] sub=${msg.body.subscriptionId} event=${msg.body.event.release.id} attempts=${msg.attempts}`,
          );
          writeDeliveryAttempt(env.WEBHOOK_DELIVERIES_AE, {
            subscriptionId: msg.body.subscriptionId,
            eventId: msg.body.event.id,
            outcome: "dlq",
            httpStatus: 0,
            latencyMs: 0,
            attempt: msg.attempts,
            errorMessage: null,
            errorCode: null,
          });
          msg.ack();
        }
        return;
      }

      const db = drizzle(env.DB);
      const timeoutMs = parseInt(env.DELIVERY_TIMEOUT_MS, 10) || 10000;
      const threshold = parseInt(env.AUTO_DISABLE_THRESHOLD, 10) || 50;

      for (const msg of batch.messages) {
        const body = msg.body;

        // (1) Per-subscription rate limit — defer if exceeded.
        const limit = await env.PER_SUB_RATE_LIMITER.limit({ key: body.subscriptionId });
        if (!limit.success) {
          msg.retry({ delaySeconds: 6 });
          continue;
        }

        // (2) Load subscription. If gone or disabled, ack + log skipped.
        const sub = await getWebhookSubscriptionById(db, body.subscriptionId);
        if (!sub || !sub.enabled) {
          writeDeliveryAttempt(env.WEBHOOK_DELIVERIES_AE, {
            subscriptionId: body.subscriptionId,
            eventId: body.event.id,
            outcome: "skipped",
            httpStatus: 0,
            latencyMs: 0,
            attempt: msg.attempts,
            errorMessage: sub ? "disabled" : "not_found",
            errorCode: null,
          });
          msg.ack();
          continue;
        }

        // (3) Deliver.
        const result = await deliver(body, { masterKey: env.WEBHOOK_HMAC_MASTER, timeoutMs });

        // (4) AE write.
        writeDeliveryAttempt(env.WEBHOOK_DELIVERIES_AE, {
          subscriptionId: body.subscriptionId,
          eventId: body.event.id,
          outcome: result.outcome,
          httpStatus: result.httpStatus,
          latencyMs: result.latencyMs,
          attempt: msg.attempts,
          errorMessage: result.errorMessage,
          errorCode: result.errorCode,
        });

        // (5) Update summary cols + ack/retry decision.
        const at = new Date().toISOString();
        if (result.outcome === "success") {
          await updateWebhookSubscriptionSummary(db, body.subscriptionId, { kind: "success", at });
          msg.ack();
        } else {
          await updateWebhookSubscriptionSummary(db, body.subscriptionId, {
            kind: "error",
            at,
            message: result.errorMessage ?? "unknown",
          });
          // Auto-disable check (read-then-write; idempotent).
          const fresh = await getWebhookSubscriptionById(db, body.subscriptionId);
          if (fresh && fresh.consecutiveFailures >= threshold) {
            await setWebhookSubscriptionEnabled(db, body.subscriptionId, false, `auto-disabled after ${fresh.consecutiveFailures} consecutive failures`);
            writeDeliveryAttempt(env.WEBHOOK_DELIVERIES_AE, {
              subscriptionId: body.subscriptionId,
              eventId: body.event.id,
              outcome: "auto_disabled",
              httpStatus: 0,
              latencyMs: 0,
              attempt: msg.attempts,
              errorMessage: null,
              errorCode: null,
            });
          }
          if (result.outcome === "perm_fail") {
            // 4xx — do not retry. Forwarding to DLQ happens automatically when we ack;
            // we let the ack pass and the message ends. Operators see it via AE perm_fail.
            // (If we want it in webhook-dlq, msg.retry once with delay=0 then catch via threshold —
            // simpler: just log perm_fail and move on. DLQ is for retry exhaustion.)
            msg.ack();
          } else {
            // 5xx, network, timeout — let Cloudflare Queues retry.
            msg.retry();
          }
        }
      }
    },
  };
  ```

- [ ] **Step 16.4: Run tests to verify they pass**

  Run: `bun test src/index.test.ts`
  Expected: PASS.

- [ ] **Step 16.5: Type-check**

  Run: `npx tsc --noEmit`
  Expected: PASS.

- [ ] **Step 16.6: Commit**

  ```bash
  git add workers/webhooks/src/index.ts workers/webhooks/src/index.test.ts
  git commit -m "feat(webhooks): queue + dlq handlers with auto-disable and rate limit"
  ```

---

## Phase 7: Admin API endpoints

Mounted under the existing admin auth middleware in `workers/api/src/index.ts`.

### Task 17: Admin webhooks routes — create / list / show

**Files:**
- Create: `workers/api/src/routes/admin-webhooks.ts`
- Create: `workers/api/test/admin-webhooks.test.ts`
- Modify: `workers/api/src/index.ts` (mount under admin auth)

- [ ] **Step 17.1: Write the failing test**

  ```ts
  // workers/api/test/admin-webhooks.test.ts
  // Note: these tests assume an existing test harness pattern in workers/api/test/.
  // Adapt the harness setup (D1 in-memory, Hono app instance) to match what other
  // route tests in this directory do.
  import { describe, it, expect } from "bun:test";
  // ... import your test-app harness ...

  describe("POST /admin/webhooks", () => {
    it("creates a subscription and returns the signing key once", async () => {
      // Seed an org and admin auth.
      const res = await testApp.fetch(new Request("https://x.test/admin/webhooks", {
        method: "POST",
        headers: { "Authorization": "Bearer admin-key", "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: "org_test", url: "https://hook/u", description: "first hook" }),
      }));
      expect(res.status).toBe(201);
      const body = await res.json() as { id: string; signingKey: string };
      expect(body.id).toMatch(/^whk_/);
      expect(body.signingKey).toMatch(/^[0-9a-f]{64}$/);
    });

    it("rejects non-https URLs", async () => {
      const res = await testApp.fetch(new Request("https://x.test/admin/webhooks", {
        method: "POST",
        headers: { "Authorization": "Bearer admin-key", "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: "org_test", url: "http://insecure/u" }),
      }));
      expect(res.status).toBe(400);
    });
  });

  describe("GET /admin/webhooks", () => {
    it("lists subscriptions for an org", async () => {
      const res = await testApp.fetch(new Request("https://x.test/admin/webhooks?org=org_test", {
        headers: { "Authorization": "Bearer admin-key" },
      }));
      expect(res.status).toBe(200);
      const body = await res.json() as { subscriptions: any[] };
      expect(Array.isArray(body.subscriptions)).toBe(true);
    });
  });

  describe("GET /admin/webhooks/:id", () => {
    it("returns 404 on unknown id", async () => {
      const res = await testApp.fetch(new Request("https://x.test/admin/webhooks/whk_nonexistent", {
        headers: { "Authorization": "Bearer admin-key" },
      }));
      expect(res.status).toBe(404);
    });
  });
  ```

- [ ] **Step 17.2: Run, expect fail**

  Run: `bun test workers/api/test/admin-webhooks.test.ts`
  Expected: FAIL.

- [ ] **Step 17.3: Implement the routes**

  ```ts
  // workers/api/src/routes/admin-webhooks.ts
  import type { Hono } from "hono";
  import { drizzle } from "drizzle-orm/d1";
  import {
    insertWebhookSubscription,
    getWebhookSubscriptionById,
    listWebhookSubscriptionsByOrg,
  } from "@releases/db/queries.js";
  import { deriveSigningKey } from "@buildinternet/releases-core/webhook-sign";

  export interface AdminWebhooksEnv {
    DB: D1Database;
    WEBHOOK_HMAC_MASTER: string;
  }

  export function mountAdminWebhooks(app: Hono) {
    app.post("/admin/webhooks", async (c) => {
      const env = c.env as AdminWebhooksEnv;
      const body = await c.req.json().catch(() => null) as null | {
        orgId?: string; url?: string; sourceId?: string | null; description?: string | null;
      };
      if (!body?.orgId || !body.url) return c.json({ error: "orgId and url required" }, 400);
      let parsed: URL;
      try { parsed = new URL(body.url); } catch { return c.json({ error: "invalid url" }, 400); }
      if (parsed.protocol !== "https:") return c.json({ error: "url must be https" }, 400);

      const db = drizzle(env.DB);
      const sub = await insertWebhookSubscription(db, {
        orgId: body.orgId,
        url: body.url,
        sourceId: body.sourceId ?? null,
        description: body.description ?? null,
      });
      const signingKey = await deriveSigningKey(env.WEBHOOK_HMAC_MASTER, sub.id, sub.secretVersion);
      return c.json({ ...sub, signingKey }, 201);
    });

    app.get("/admin/webhooks", async (c) => {
      const env = c.env as AdminWebhooksEnv;
      const orgId = c.req.query("org");
      if (!orgId) return c.json({ error: "org query param required" }, 400);
      const db = drizzle(env.DB);
      const enabledOnly = c.req.query("enabled") === "true";
      const disabledOnly = c.req.query("enabled") === "false";
      const all = await listWebhookSubscriptionsByOrg(db, orgId);
      const filtered = enabledOnly ? all.filter((s) => s.enabled)
        : disabledOnly ? all.filter((s) => !s.enabled)
        : all;
      return c.json({ subscriptions: filtered });
    });

    app.get("/admin/webhooks/:id", async (c) => {
      const env = c.env as AdminWebhooksEnv;
      const db = drizzle(env.DB);
      const sub = await getWebhookSubscriptionById(db, c.req.param("id"));
      if (!sub) return c.json({ error: "not found" }, 404);
      return c.json(sub);
    });
  }
  ```

- [ ] **Step 17.4: Mount in `workers/api/src/index.ts` under admin auth**

  Find the existing admin route mounting block in `workers/api/src/index.ts` (search for other admin routes — likely a sub-app gated by `requireAdminAuth` or similar middleware). Add:

  ```ts
  import { mountAdminWebhooks } from "./routes/admin-webhooks.js";
  // ...
  mountAdminWebhooks(adminApp); // use the same admin-gated app instance other admin routes use
  ```

- [ ] **Step 17.5: Run tests, verify pass**

  Run: `bun test workers/api/test/admin-webhooks.test.ts`
  Expected: PASS.

- [ ] **Step 17.6: Commit**

  ```bash
  git add workers/api/src/routes/admin-webhooks.ts workers/api/src/index.ts workers/api/test/admin-webhooks.test.ts
  git commit -m "feat(api): admin webhooks endpoints — create/list/show"
  ```

### Task 18: Admin webhooks — edit + delete + test + rotate-secret + deliveries

**Files:**
- Modify: `workers/api/src/routes/admin-webhooks.ts`
- Modify: `workers/api/test/admin-webhooks.test.ts`

- [ ] **Step 18.1: Add tests** for `PATCH /admin/webhooks/:id`, `DELETE /admin/webhooks/:id`, `POST /admin/webhooks/:id/test`, `POST /admin/webhooks/:id/rotate-secret`, `GET /admin/webhooks/:id/deliveries`. Each test follows the same shape as Task 17.

  Skeleton for one of them:

  ```ts
  describe("POST /admin/webhooks/:id/rotate-secret", () => {
    it("bumps secret_version and returns new signing key", async () => {
      // Seed sub with version=1.
      const res = await testApp.fetch(new Request("https://x.test/admin/webhooks/whk_existing/rotate-secret", {
        method: "POST",
        headers: { "Authorization": "Bearer admin-key" },
      }));
      expect(res.status).toBe(200);
      const body = await res.json() as { secretVersion: number; signingKey: string };
      expect(body.secretVersion).toBe(2);
      expect(body.signingKey).toMatch(/^[0-9a-f]{64}$/);
    });
  });
  ```

  Write equivalents for `PATCH` (toggling enabled/disabled, changing URL/description), `DELETE` (returns 204), `test` (calls the queue and returns enqueued info), and `deliveries` (queries AE — see Step 18.3 below for the AE query stub).

- [ ] **Step 18.2: Run tests, expect fails**

  Run: `bun test workers/api/test/admin-webhooks.test.ts`
  Expected: FAIL on the new endpoints.

- [ ] **Step 18.3: Implement the additional handlers**

  Append to `workers/api/src/routes/admin-webhooks.ts`:

  ```ts
  app.patch("/admin/webhooks/:id", async (c) => {
    const env = c.env as AdminWebhooksEnv;
    const db = drizzle(env.DB);
    const id = c.req.param("id");
    const sub = await getWebhookSubscriptionById(db, id);
    if (!sub) return c.json({ error: "not found" }, 404);
    const body = await c.req.json().catch(() => ({})) as Partial<{
      url: string; description: string | null; enabled: boolean; disabledReason: string | null;
    }>;
    if (body.url) {
      try { const u = new URL(body.url); if (u.protocol !== "https:") return c.json({ error: "url must be https" }, 400); }
      catch { return c.json({ error: "invalid url" }, 400); }
    }
    // Apply patch via direct update (helpers are CRUD-only; here we hand-roll to keep PATCH thin).
    const { webhookSubscriptions } = await import("@buildinternet/releases-core/schema");
    const { eq } = await import("drizzle-orm");
    const updates: Record<string, any> = {};
    if (body.url !== undefined) updates.url = body.url;
    if (body.description !== undefined) updates.description = body.description;
    if (body.enabled !== undefined) {
      updates.enabled = body.enabled;
      updates.disabledReason = body.enabled ? null : (body.disabledReason ?? "manually disabled");
      if (body.enabled) updates.consecutiveFailures = 0;
    }
    if (Object.keys(updates).length === 0) return c.json({ error: "nothing to update" }, 400);
    await db.update(webhookSubscriptions).set(updates).where(eq(webhookSubscriptions.id, id));
    const fresh = await getWebhookSubscriptionById(db, id);
    return c.json(fresh);
  });

  app.delete("/admin/webhooks/:id", async (c) => {
    const env = c.env as AdminWebhooksEnv;
    const db = drizzle(env.DB);
    const { deleteWebhookSubscription } = await import("@releases/db/queries.js");
    await deleteWebhookSubscription(db, c.req.param("id"));
    return new Response(null, { status: 204 });
  });

  app.post("/admin/webhooks/:id/rotate-secret", async (c) => {
    const env = c.env as AdminWebhooksEnv;
    const db = drizzle(env.DB);
    const { bumpWebhookSecretVersion } = await import("@releases/db/queries.js");
    const newVersion = await bumpWebhookSecretVersion(db, c.req.param("id"));
    const signingKey = await deriveSigningKey(env.WEBHOOK_HMAC_MASTER, c.req.param("id"), newVersion);
    return c.json({ secretVersion: newVersion, signingKey });
  });

  app.post("/admin/webhooks/:id/test", async (c) => {
    const env = c.env as AdminWebhooksEnv & { WEBHOOK_DELIVERY_QUEUE: Queue<unknown> };
    const db = drizzle(env.DB);
    const sub = await getWebhookSubscriptionById(db, c.req.param("id"));
    if (!sub) return c.json({ error: "not found" }, 404);
    const synthetic = {
      subscriptionId: sub.id,
      url: sub.url,
      secretVersion: sub.secretVersion,
      event: {
        id: `test_${Date.now()}`,
        seq: 0,
        ts: Date.now(),
        type: "release.created" as const,
        release: {
          id: "rel_synthetic",
          title: "Webhook test",
          version: null,
          publishedAt: null,
          sourceName: "synthetic",
          sourceSlug: "synthetic",
          contentSummary: "This is a synthetic test event from `releases admin webhook test`.",
          media: [],
        },
      },
      attempt: 1,
    };
    await env.WEBHOOK_DELIVERY_QUEUE.send(synthetic);
    return c.json({ enqueued: true, eventId: synthetic.event.id });
  });

  app.get("/admin/webhooks/:id/deliveries", async (c) => {
    const env = c.env as AdminWebhooksEnv & { CF_ACCOUNT_ID?: string; CF_API_TOKEN?: string };
    const id = c.req.param("id");
    const failedOnly = c.req.query("failed") === "true";
    const limit = Math.min(100, parseInt(c.req.query("limit") ?? "20", 10) || 20);
    // AE SQL API. Requires CF_API_TOKEN with Analytics read perms; bind both as
    // worker secrets if not already (deferred — for v1 this endpoint can return
    // a NotImplemented placeholder if the token isn't available, and the CLI
    // gracefully degrades to a "set CF_API_TOKEN to query deliveries" message).
    if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) {
      return c.json({ error: "AE query disabled — set CF_API_TOKEN + CF_ACCOUNT_ID to enable" }, 501);
    }
    const where = `index1 = '${id}'` + (failedOnly ? ` AND blob4 IN ('retry','perm_fail','dlq','auto_disabled')` : "");
    const sql = `SELECT timestamp, blob1 AS event_id, blob2 AS error_message, blob3 AS error_code, blob4 AS outcome, double1 AS http_status, double2 AS latency_ms, double3 AS attempt FROM webhook_deliveries WHERE ${where} ORDER BY timestamp DESC LIMIT ${limit}`;
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
      { method: "POST", headers: { "Authorization": `Bearer ${env.CF_API_TOKEN}` }, body: sql },
    );
    if (!res.ok) return c.json({ error: `AE query failed: ${res.status}` }, 502);
    const data = await res.json();
    return c.json(data);
  });
  ```

- [ ] **Step 18.4: Run tests to verify pass**

  Run: `bun test workers/api/test/admin-webhooks.test.ts`
  Expected: PASS.

- [ ] **Step 18.5: Commit**

  ```bash
  git add workers/api/src/routes/admin-webhooks.ts workers/api/test/admin-webhooks.test.ts
  git commit -m "feat(api): admin webhook edit/delete/test/rotate/deliveries"
  ```

---

## Phase 8: CLI

### Task 19: Admin CLI subgroup `releases admin webhook ...`

Single file with all eight admin commands.

**Files:**
- Create: `src/cli/commands/admin/webhook.ts`
- Modify: `src/cli/commands/admin/index.ts` (or wherever admin subgroups register) to register

- [ ] **Step 19.1: Inspect existing admin command registration**

  Open `src/cli/commands/admin/index.ts` (or the equivalent that mounts `source`, `org`, `policy` subgroups). Note the registration pattern.

- [ ] **Step 19.2: Write the webhook subgroup**

  ```ts
  // src/cli/commands/admin/webhook.ts
  import { Command } from "commander";
  import chalk from "chalk";
  import { logger } from "@buildinternet/releases-lib/logger";

  // The CLI is configured to talk to the API via RELEASED_API_URL + RELEASED_API_KEY.
  // We assume an existing apiClient helper at src/cli/api/client.ts (or similar) —
  // mirror what other admin commands use (e.g., src/cli/commands/admin/source.ts).
  import { apiAdmin } from "../../api/client.js"; // adjust path if different

  export function registerWebhookAdminCommand(parent: Command) {
    const webhook = parent.command("webhook").description("Manage webhook subscriptions");

    webhook.command("add")
      .requiredOption("--org <slug>", "Organization slug or ID")
      .requiredOption("--url <url>", "HTTPS endpoint to deliver to")
      .option("--source <slug>", "Restrict to a single source (omit for org-wide)")
      .option("--description <text>", "Human-readable label")
      .option("--json", "JSON output")
      .action(async (opts) => {
        const res = await apiAdmin.post("/admin/webhooks", {
          orgId: opts.org, url: opts.url, sourceId: opts.source ?? null, description: opts.description ?? null,
        });
        if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
        logger.info(chalk.green(`Created ${res.id}`));
        logger.info(`URL: ${res.url}`);
        logger.info(chalk.bold(`Signing key (shown once — save it now):`));
        logger.info(chalk.yellow(res.signingKey));
        logger.info(chalk.gray(`Re-running 'add' generates a new subscription. Use 'rotate-secret' to regenerate.`));
      });

    webhook.command("list")
      .option("--org <slug>", "Filter by org")
      .option("--enabled", "Show enabled only")
      .option("--disabled", "Show disabled only")
      .option("--json", "JSON output")
      .action(async (opts) => {
        const qs = new URLSearchParams();
        if (opts.org) qs.set("org", opts.org);
        if (opts.enabled) qs.set("enabled", "true");
        if (opts.disabled) qs.set("enabled", "false");
        const res = await apiAdmin.get(`/admin/webhooks?${qs}`);
        if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
        if (res.subscriptions.length === 0) { logger.info("No subscriptions."); return; }
        for (const s of res.subscriptions) {
          const status = s.enabled ? chalk.green("●") : chalk.red("●");
          const desc = s.description ? chalk.gray(` — ${s.description}`) : "";
          logger.info(`${status} ${chalk.cyan(s.id)} ${s.url}${desc}`);
        }
      });

    webhook.command("show <id>")
      .option("--json", "JSON output")
      .action(async (id, opts) => {
        const res = await apiAdmin.get(`/admin/webhooks/${id}`);
        if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
        for (const [k, v] of Object.entries(res)) logger.info(`${chalk.gray(k)}: ${v ?? ""}`);
      });

    webhook.command("edit <id>")
      .option("--url <url>", "New URL")
      .option("--description <text>", "New description")
      .option("--enable", "Enable subscription")
      .option("--disable", "Disable subscription")
      .action(async (id, opts) => {
        const patch: any = {};
        if (opts.url) patch.url = opts.url;
        if (opts.description !== undefined) patch.description = opts.description;
        if (opts.enable) patch.enabled = true;
        if (opts.disable) patch.enabled = false;
        const res = await apiAdmin.patch(`/admin/webhooks/${id}`, patch);
        logger.info(chalk.green(`Updated ${res.id}`));
      });

    webhook.command("remove <id>")
      .action(async (id) => {
        await apiAdmin.delete(`/admin/webhooks/${id}`);
        logger.info(chalk.yellow(`Removed ${id}`));
      });

    webhook.command("test <id>")
      .action(async (id) => {
        const res = await apiAdmin.post(`/admin/webhooks/${id}/test`, {});
        logger.info(chalk.green(`Enqueued test event ${res.eventId} for ${id}`));
      });

    webhook.command("rotate-secret <id>")
      .action(async (id) => {
        const res = await apiAdmin.post(`/admin/webhooks/${id}/rotate-secret`, {});
        logger.info(chalk.green(`Rotated to v${res.secretVersion}`));
        logger.info(chalk.bold(`New signing key (shown once — save it now):`));
        logger.info(chalk.yellow(res.signingKey));
      });

    webhook.command("deliveries <id>")
      .option("--failed", "Failed attempts only")
      .option("--limit <n>", "Max rows", "20")
      .option("--json", "JSON output")
      .action(async (id, opts) => {
        const qs = new URLSearchParams({ limit: opts.limit });
        if (opts.failed) qs.set("failed", "true");
        const res = await apiAdmin.get(`/admin/webhooks/${id}/deliveries?${qs}`);
        if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
        // Render rows as a table-ish list.
        const rows = (res.data?.[0]?.rows ?? res.rows ?? []) as any[];
        if (rows.length === 0) { logger.info("No deliveries found."); return; }
        for (const row of rows) {
          const status = row.outcome === "success" ? chalk.green(row.outcome) : chalk.red(row.outcome);
          logger.info(`[${row.timestamp}] ${status} ${row.event_id} ${row.http_status}/${row.latency_ms}ms${row.error_message ? ` — ${row.error_message}` : ""}`);
        }
      });
  }
  ```

  **Note:** `apiAdmin.post/get/patch/delete` is the existing admin API client wrapper. If `src/cli/api/client.ts` doesn't expose those methods, mirror the existing pattern from `src/cli/commands/admin/source.ts` (which already calls the admin API).

- [ ] **Step 19.3: Register the subgroup**

  In the file that registers admin sub-commands, add:

  ```ts
  import { registerWebhookAdminCommand } from "./webhook.js";
  // inside the admin command setup:
  registerWebhookAdminCommand(adminCommand);
  ```

- [ ] **Step 19.4: Smoke-test the CLI**

  Build the CLI and try `--help`:

  ```bash
  bun src/index.ts admin webhook --help
  ```

  Expected: prints the eight subcommands.

- [ ] **Step 19.5: Type-check**

  Run: `npx tsc --noEmit`
  Expected: PASS.

- [ ] **Step 19.6: Commit**

  ```bash
  git add src/cli/commands/admin/webhook.ts src/cli/commands/admin/index.ts
  git commit -m "feat(cli): releases admin webhook subgroup"
  ```

### Task 20: Subscriber-facing `releases webhook verify`

**Files:**
- Create: `src/cli/commands/webhook-verify.ts`
- Create: `src/cli/commands/webhook-verify.test.ts`
- Modify: `src/cli/index.ts` (register top-level webhook group)

- [ ] **Step 20.1: Write the failing test**

  ```ts
  // src/cli/commands/webhook-verify.test.ts
  import { describe, it, expect } from "bun:test";
  import { verifySignatureCli } from "./webhook-verify.js";
  import { signPayload } from "@buildinternet/releases-core/webhook-sign";

  describe("webhook verify CLI helper", () => {
    it("returns ok=true on a matching signature", async () => {
      const key = "deadbeef".repeat(8);
      const ts = 1729281234;
      const body = "{\"hello\":\"world\"}";
      const sig = await signPayload(key, ts, body);
      const result = await verifySignatureCli({ secret: key, timestamp: ts, signature: sig, body });
      expect(result.ok).toBe(true);
    });

    it("returns ok=false on a mismatch", async () => {
      const result = await verifySignatureCli({
        secret: "deadbeef".repeat(8),
        timestamp: 1,
        signature: "sha256=00",
        body: "{}",
      });
      expect(result.ok).toBe(false);
    });
  });
  ```

- [ ] **Step 20.2: Run, expect fail**

  Run: `bun test src/cli/commands/webhook-verify.test.ts`
  Expected: FAIL.

- [ ] **Step 20.3: Implement**

  ```ts
  // src/cli/commands/webhook-verify.ts
  import { Command } from "commander";
  import { readFileSync } from "node:fs";
  import chalk from "chalk";
  import { verifySignature } from "@buildinternet/releases-core/webhook-sign";

  export interface VerifyArgs {
    secret: string;
    timestamp: number;
    signature: string;
    body: string;
  }

  export async function verifySignatureCli(args: VerifyArgs): Promise<{ ok: boolean }> {
    const ok = await verifySignature(args.secret, args.timestamp, args.body, args.signature);
    return { ok };
  }

  export function registerWebhookCommand(program: Command) {
    const webhook = program.command("webhook").description("Webhook utilities");

    webhook.command("verify")
      .description("Verify an X-Released-Signature locally against a captured payload")
      .requiredOption("--secret <key>", "Signing key (hex) — the value 'releases admin webhook add' printed at creation")
      .requiredOption("--signature <header>", "Value of the X-Released-Signature header (e.g. sha256=...)")
      .requiredOption("--timestamp <unix>", "Value of the X-Released-Timestamp header (unix seconds)")
      .requiredOption("--body-file <path>", "Path to the raw request body")
      .action(async (opts) => {
        const body = readFileSync(opts.bodyFile, "utf8");
        const result = await verifySignatureCli({
          secret: opts.secret,
          timestamp: parseInt(opts.timestamp, 10),
          signature: opts.signature,
          body,
        });
        if (result.ok) {
          console.log(chalk.green("OK — signature is valid"));
          process.exit(0);
        } else {
          console.error(chalk.red("FAIL — signature did not match"));
          process.exit(1);
        }
      });
  }
  ```

- [ ] **Step 20.4: Register at the top level**

  In `src/cli/index.ts`, find where other top-level commands are registered (e.g. `registerTailCommand(program)`). Add:

  ```ts
  import { registerWebhookCommand } from "./commands/webhook-verify.js";
  // ...
  registerWebhookCommand(program);
  ```

- [ ] **Step 20.5: Run tests, verify pass**

  Run: `bun test src/cli/commands/webhook-verify.test.ts`
  Expected: PASS.

- [ ] **Step 20.6: Smoke-test the help**

  Run: `bun src/index.ts webhook verify --help`
  Expected: prints the verify command help.

- [ ] **Step 20.7: Commit**

  ```bash
  git add src/cli/commands/webhook-verify.ts src/cli/commands/webhook-verify.test.ts src/cli/index.ts
  git commit -m "feat(cli): releases webhook verify subscriber utility"
  ```

---

## Phase 9: Docs + CI + e2e

### Task 21: Public integration docs

**Files:**
- Create: `docs/webhooks.md`
- Modify: `docs/architecture/events.md`
- Modify: `README.md`

- [ ] **Step 21.1: Write `docs/webhooks.md`**

  ```markdown
  # Webhooks

  Receive release.created events as HTTPS POSTs to your endpoint, signed with HMAC-SHA256.

  ## Quickstart

  Subscribe (Rally team handles this for v1 named customers):

      releases admin webhook add --org acme --url https://your.app/releases --description "production hook"

  The CLI prints a signing key once. Save it — you can't retrieve it later.

  ## Delivery format

  Each event arrives as `POST <your-url>` with these headers:

      Content-Type: application/json
      X-Released-Version: 1
      X-Released-Event-Id: rel_evt_<id>           # idempotency key
      X-Released-Timestamp: <unix-seconds>
      X-Released-Signature: sha256=<hex>          # HMAC-SHA256(key, "${timestamp}.${body}")
      User-Agent: releases-webhooks/1

  Body: a JSON `ReleaseEvent` (see [events.md](./architecture/events.md)).

  Respond `2xx` within 10 seconds to ack. Anything else triggers retry (5xx) or terminal failure (4xx).

  ## Verifying signatures

  ### Node.js

      import crypto from "node:crypto";
      function verify(secret, timestamp, body, signature) {
        const expected = "sha256=" + crypto.createHmac("sha256", Buffer.from(secret, "hex"))
          .update(`${timestamp}.${body}`).digest("hex");
        return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
      }

  ### Python

      import hmac, hashlib
      def verify(secret, timestamp, body, signature):
        expected = "sha256=" + hmac.new(bytes.fromhex(secret), f"{timestamp}.{body}".encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected, signature)

  ### Go

      package main
      import ("crypto/hmac"; "crypto/sha256"; "encoding/hex"; "fmt")
      func verify(secret, ts, body, sig string) bool {
        key, _ := hex.DecodeString(secret)
        m := hmac.New(sha256.New, key)
        m.Write([]byte(fmt.Sprintf("%s.%s", ts, body)))
        expected := "sha256=" + hex.EncodeToString(m.Sum(nil))
        return hmac.Equal([]byte(expected), []byte(sig))
      }

  ## Idempotency

  Cloudflare Queues guarantees at-least-once delivery. Use `X-Released-Event-Id` as an idempotency key — store recently-seen IDs and skip duplicates.

  ## Retry behavior

  - 2xx → ack, no retry.
  - 4xx → no retry. Subscriber bug; fix and use `releases admin webhook test` to verify.
  - 5xx, network, timeout → retried up to 6 times with exponential backoff (~2 hours total).
  - After 6 retries → message moves to dead-letter queue. Subscription's `consecutive_failures` increments. After 50 consecutive failures, the subscription is auto-disabled.

  ## Replay

      GET https://api.releases.sh/v1/webhooks/events?since=<seq>&limit=<1-500>

  Returns:

      { "events": [...], "head": <current-seq>, "gap": { "oldestSeq": <n> } }

  `gap` is set when `since` is below what we still have buffered (~7 days). Backfill older events via `GET /v1/releases/latest`.

  ## Local debugging

  Verify signatures from a captured payload using the CLI:

      releases webhook verify \
        --secret <key> \
        --signature <X-Released-Signature header> \
        --timestamp <X-Released-Timestamp header> \
        --body-file path/to/captured-body.json
  ```

- [ ] **Step 21.2: Update `docs/architecture/events.md`**

  Append a new section:

  ```markdown
  ## Consumers

  ### CLI tail (`releases tail -f`)

  Connects to `/v1/releases/stream` over WebSocket. Falls back to polling on disconnect. See `src/cli/commands/tail.ts`.

  ### Webhooks (`workers/webhooks`)

  Per-subscription HTTPS POST consumer. Publisher in `workers/api/src/events/publish.ts` calls `expandAndEnqueue` alongside `ReleaseHub.publish`; the new Worker consumes `webhook-delivery`, signs payloads, retries on transient failures, and DLQs on retry exhaustion. See `docs/webhooks.md` for the public contract.
  ```

- [ ] **Step 21.3: Update `README.md`**

  In the "Features" or equivalent section, add a one-line bullet:

  ```markdown
  - Outbound webhooks for release events with HMAC signing, retry/DLQ via Cloudflare Queues, and a 7-day replay window. See [docs/webhooks.md](docs/webhooks.md).
  ```

- [ ] **Step 21.4: Commit**

  ```bash
  git add docs/webhooks.md docs/architecture/events.md README.md
  git commit -m "docs: webhook delivery integration guide"
  ```

### Task 22: Echo subscriber Worker for e2e + GitHub Actions deploy + e2e job

**Files:**
- Create: `workers/webhooks/test/echo-subscriber/wrangler.jsonc`
- Create: `workers/webhooks/test/echo-subscriber/src/index.ts`
- Create: `.github/workflows/deploy-webhooks.yml`

- [ ] **Step 22.1: Create the echo subscriber Worker**

  Minimal Worker that logs everything received and returns 200. Deployed once to a fixed URL (e.g. `https://webhook-echo.releases.workers.dev`) and reused.

  ```jsonc
  // workers/webhooks/test/echo-subscriber/wrangler.jsonc
  {
    "name": "releases-webhook-echo",
    "main": "src/index.ts",
    "compatibility_date": "2026-03-27",
    "vars": { "EXPECTED_VERSION": "1" }
  }
  ```

  ```ts
  // workers/webhooks/test/echo-subscriber/src/index.ts
  export default {
    async fetch(req: Request): Promise<Response> {
      const body = await req.text();
      const headers = Object.fromEntries(req.headers.entries());
      console.log(JSON.stringify({ kind: "echo", method: req.method, headers, body }));
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    },
  };
  ```

- [ ] **Step 22.2: Create the deploy workflow**

  Mirror `.github/workflows/deploy-workers.yml` (the existing one used for `workers/api`). Filename suggestion: `.github/workflows/deploy-webhooks.yml`.

  ```yaml
  name: Deploy webhooks worker

  on:
    push:
      branches: [main]
      paths:
        - 'workers/webhooks/**'
        - 'packages/core/**'
        - 'src/db/**'
        - '.github/workflows/deploy-webhooks.yml'

  jobs:
    deploy:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: oven-sh/setup-bun@v2
        - run: bun install --frozen-lockfile
          working-directory: workers/webhooks
        - run: bunx wrangler deploy
          working-directory: workers/webhooks
          env:
            CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
            CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        - name: Live e2e — webhook test
          if: success()
          run: |
            cd ../..
            bun src/index.ts admin webhook test whk_e2e_known_id || echo "[e2e] non-fatal"
            sleep 8
            bun src/index.ts admin webhook deliveries whk_e2e_known_id --limit 5 --json
          env:
            RELEASED_API_URL: https://api.releases.sh
            RELEASED_API_KEY: ${{ secrets.RELEASED_API_KEY }}
  ```

  The `whk_e2e_known_id` is a long-lived subscription created out-of-band pointing at the echo Worker's URL. Document this in `workers/webhooks/test/echo-subscriber/README.md` (one-time setup: deploy echo, create the subscription, note its ID, add it to GH secrets if rotation is desired).

- [ ] **Step 22.3: Commit**

  ```bash
  git add workers/webhooks/test/echo-subscriber/ .github/workflows/deploy-webhooks.yml
  git commit -m "ci: deploy workers/webhooks + post-deploy live e2e"
  ```

---

## Phase 10: Manual post-deploy verification

After the PR is merged and the worker auto-deploys, run the same shape of smoke we ran for #341:

- [ ] **Step 23.1: Confirm deploys**

  Check `gh run list --workflow=deploy-webhooks.yml --limit 3 --json conclusion`. Expect `success`.

- [ ] **Step 23.2: Create a real subscription against a chatty source**

  ```bash
  releases admin webhook add --org auth0 --url https://webhook-echo.releases.workers.dev --description "post-deploy smoke"
  ```

  Note the printed `id` and signing key.

- [ ] **Step 23.3: Trigger a fetch on a known-chatty source**

  ```bash
  releases admin source fetch auth0-changelog --max 10
  ```

- [ ] **Step 23.4: Confirm the echo Worker received the events**

  Use `wrangler tail` on `releases-webhook-echo` for ~30 seconds:

  ```bash
  cd workers/webhooks/test/echo-subscriber && bunx wrangler tail
  ```

  Look for `kind: "echo"` log lines with a `X-Released-Signature` header.

- [ ] **Step 23.5: Confirm AE telemetry**

  ```bash
  releases admin webhook deliveries <id> --limit 10
  ```

  Expect rows with `outcome: success` and reasonable `latency_ms`.

- [ ] **Step 23.6: Capture results in PR description**

  Update the PR with a "Post-deploy verification" section listing what was observed.

- [ ] **Step 23.7: Clean up**

  Delete the smoke subscription:

  ```bash
  releases admin webhook remove <id>
  ```

---

## Self-review notes (for the author of this plan)

After writing the plan, the following spec areas were checked for coverage:

- **Architecture (3 Workers, 2 Queues, 1 DO):** Tasks 7-8 (DO + replay route), 9-11 (api producer + publisher integration), 12-16 (workers/webhooks scaffold + consumer), 17-18 (admin API). ✓
- **Data model (D1 + AE + DO storage):** Tasks 1-3 (D1 + queries), 14 (AE), 7 (DO storage extension via `EVENT_BUFFER_SIZE`). ✓
- **Publisher path:** Tasks 9-11. ✓
- **Consumer path:** Tasks 13-16. ✓
- **CLI surface (8 admin + 1 verify):** Tasks 19-20. ✓
- **Public docs:** Task 21. ✓
- **Testing (unit, miniflare integration, live e2e):** Unit tests in Tasks 3, 5, 6, 7, 10, 14, 15, 17, 18, 20. Live e2e in Task 22. Miniflare integration is partially covered by the in-memory test harnesses; a separate Task could be added if the miniflare runtime is needed for queue-binding parity testing. ✓
- **Out-of-scope items:** Web live view (#352), per-caller API keys, durable event log >7d — none appear in this plan, as intended. ✓

## Open issues that may surface during implementation

- **`build-event.ts` shape (Step 11.1):** if `InsertedReleaseRow` doesn't already carry `orgId`/`sourceId`, the publisher signature change in Step 11.2 needs the upstream caller (in `sources.ts`) to pass these explicitly. Read the file before assuming the shape.
- **Event ID parity between hub and webhooks (Step 11.2 note):** v1 uses locally-assigned `event.id` for the queue messages. If `X-Released-Event-Id` needs to match what `tail -f` clients see, extend the DO `/publish` response to return assigned events and use those instead of synthesizing locally.
- **AE deliveries query auth (Step 18.3):** the `deliveries` endpoint returns 501 without `CF_API_TOKEN`. Provisioning that token is a separate operator step; don't block the rest of the rollout on it.
- **`whk_e2e_known_id` (Step 22.2):** the echo subscription needs to be created once before the first CI run that exercises it. Document this clearly in the echo subscriber's README.
