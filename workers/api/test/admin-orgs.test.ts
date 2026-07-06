import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { applyMigrations } from "../../../tests/db-helper";
import { organizations } from "@buildinternet/releases-core/schema";

function mkDb() {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys=ON");
  applyMigrations(sqlite);
  return drizzle(sqlite);
}

async function makeApp(db: ReturnType<typeof mkDb>) {
  const { Hono } = await import("hono");
  const { adminOrgsRoutes } = await import("../src/routes/admin-orgs.js");
  const app = new Hono();
  const v1 = new Hono();
  v1.route("/", adminOrgsRoutes);
  app.route("/v1", v1);
  return (req: Request) => app.fetch(req, { DB: db });
}

async function seed(db: ReturnType<typeof mkDb>) {
  await db.insert(organizations).values([
    { id: "org_plain", slug: "plain-org", name: "Plain Org" },
    { id: "org_stamped", slug: "stamped-org", name: "Stamped Org" },
  ]);
}

describe("GET /v1/admin/orgs", () => {
  it("lists orgs unfiltered when trackingRequested is absent", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = await makeApp(db);
    const res = await fetch(new Request("http://x/v1/admin/orgs"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { slug: string }[] };
    expect(body.items.map((o) => o.slug).sort()).toEqual(["plain-org", "stamped-org"]);
  });

  it("filters to tracking-requested orgs and exposes the stamp", async () => {
    const db = mkDb();
    await seed(db);
    const now = new Date().toISOString();
    await db
      .update(organizations)
      .set({ trackingRequestedAt: now })
      .where(eq(organizations.id, "org_stamped"));

    const fetch = await makeApp(db);
    const res = await fetch(new Request("http://x/v1/admin/orgs?trackingRequested=1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { slug: string; trackingRequestedAt?: string }[];
    };
    expect(body.items.map((o) => o.slug)).toEqual(["stamped-org"]);
    expect(body.items[0]!.trackingRequestedAt).toBeTruthy();
  });
});
