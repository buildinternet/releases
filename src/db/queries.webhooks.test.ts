import { describe, it, expect, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import { webhookSubscriptions } from "@releases/core/schema";
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
  migrate(db, { migrationsFolder: "src/db/migrations" });
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
