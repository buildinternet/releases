import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createTestDb, type TestDatabase } from "../../../../tests/db-helper.js";
import { organizations } from "@buildinternet/releases-core/schema";
import { authOrganization } from "../db/schema-auth.js";
import { insertWebhookSubscription, matchWebhookSubscriptions } from "./queries.js";
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
