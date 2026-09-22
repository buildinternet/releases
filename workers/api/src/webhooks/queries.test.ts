import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createTestDb, type TestDatabase } from "../../../../tests/db-helper.js";
import { organizations } from "@buildinternet/releases-core/schema";
import { authOrganization } from "../db/schema-auth.js";
import {
  insertWebhookSubscription,
  insertWorkspaceWebhookSubscriptionCapped,
  matchWebhookSubscriptions,
} from "./queries.js";
import type { D1Db } from "../db.js";

let h: TestDatabase;

/**
 * The worker-local webhook query helpers are typed against the prod D1
 * drizzle handle; the bun:sqlite test handle is structurally compatible at
 * runtime (same drizzle query builder surface) but not assignable at the
 * type level, so tests that call them directly cast through `unknown`.
 */
function db(): D1Db {
  return h.db as unknown as D1Db;
}

beforeEach(async () => {
  h = createTestDb();
  await h.db.insert(organizations).values({ id: "org_a", name: "Acme", slug: "acme" });
  await h.db
    .insert(authOrganization)
    .values({ id: "ws_1", name: "Acme Workspace", slug: "acme-ws" });
});

afterEach(() => h.cleanup());

describe("matchWebhookSubscriptions", () => {
  it("matches a workspace-owned org-scoped row with no special-casing", async () => {
    const sub = await insertWebhookSubscription(db(), {
      scope: "org",
      orgId: "org_a",
      url: "https://1.1.1.1/hook",
      sourceId: null,
      description: null,
      workspaceId: "ws_1",
    });

    const matches = await matchWebhookSubscriptions(db(), ["org_a"]);
    expect(matches.map((m) => m.id)).toContain(sub.id);
    const matched = matches.find((m) => m.id === sub.id);
    expect(matched?.workspaceId).toBe("ws_1");
    expect(matched?.userId).toBeNull();
  });
});

describe("insertWorkspaceWebhookSubscriptionCapped", () => {
  const input = {
    workspaceId: "ws_1",
    orgId: "org_a",
    url: "https://1.1.1.1/hook",
    sourceId: null,
    productId: null,
    releaseType: null,
    format: "json" as const,
    description: null,
  };

  it("inserts below the cap and returns the full row", async () => {
    const sub = await insertWorkspaceWebhookSubscriptionCapped(db(), input, 2);
    expect(sub?.workspaceId).toBe("ws_1");
    expect(sub?.scope).toBe("org");
    expect(sub?.enabled).toBe(true);
    expect(sub?.secretVersion).toBe(1);
  });

  it("returns null and inserts nothing once the workspace is at the cap", async () => {
    const results = await Promise.all(
      [1, 2, 3].map(() => insertWorkspaceWebhookSubscriptionCapped(db(), input, 2)),
    );
    expect(results.filter(Boolean)).toHaveLength(2);
    const rows = await matchWebhookSubscriptions(db(), ["org_a"]);
    expect(rows).toHaveLength(2);
  });
});
