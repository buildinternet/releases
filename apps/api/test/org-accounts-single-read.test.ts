import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Hono } from "hono";
import { applyMigrations } from "../../../tests/db-helper";
import { orgAccounts, organizations } from "@buildinternet/releases-core/schema";
import { orgRoutes } from "../src/routes/orgs.js";

function mkDb() {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys=ON");
  applyMigrations(sqlite);
  return drizzle(sqlite);
}

function mkApp(db: ReturnType<typeof mkDb>) {
  const app = new Hono();
  const v1 = new Hono();
  v1.route("/", orgRoutes);
  app.route("/v1", v1);
  const fakeEnv = { DB: db };
  const fakeCtx = {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  return (req: Request) => app.fetch(req, fakeEnv, fakeCtx);
}

describe("GET /v1/orgs/:slug/accounts?platform= (single-account mode)", () => {
  it("deterministically returns the oldest-linked account when multiple share a platform", async () => {
    const db = mkDb();
    await db
      .insert(organizations)
      .values([{ id: "org_cf", name: "Cloudflare", slug: "cloudflare" }]);
    // Two `x` accounts on one org. The handles and insertion order both point
    // at the NEWER row (inserted first → lower rowid; "aardvark" sorts before
    // "zebra" under the (platform, handle) index), while `createdAt` points at
    // the OLDER row. So only an explicit `ORDER BY created_at ASC` returns the
    // oldest-linked account — every incidental ordering would return the newer.
    await db.insert(orgAccounts).values([
      {
        id: "acct_x_new",
        orgId: "org_cf",
        platform: "x",
        handle: "aardvark",
        createdAt: "2026-06-05T00:00:00.000Z",
      },
      {
        id: "acct_x_old",
        orgId: "org_cf",
        platform: "x",
        handle: "zebra",
        createdAt: "2020-06-30T00:00:00.000Z",
      },
    ]);

    const fetch = mkApp(db);
    const results: Array<{ platform: string; handle: string } | null> = [];
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(new Request("https://x.test/v1/orgs/cloudflare/accounts?platform=x"));
      expect(res.status).toBe(200);
      // eslint-disable-next-line no-await-in-loop
      const body = (await res.json()) as { platform: string; handle: string } | null;
      results.push(body);
    }

    // Single-row shape (object, not array), stable across calls, oldest-linked wins.
    for (const body of results) {
      expect(Array.isArray(body)).toBe(false);
      expect(body).toEqual({ platform: "x", handle: "zebra" });
    }
  });

  it("returns null for a platform the org has no account on", async () => {
    const db = mkDb();
    await db
      .insert(organizations)
      .values([{ id: "org_cf", name: "Cloudflare", slug: "cloudflare" }]);
    await db
      .insert(orgAccounts)
      .values([{ id: "acct_x", orgId: "org_cf", platform: "x", handle: "Cloudflare" }]);

    const res = await mkApp(db)(
      new Request("https://x.test/v1/orgs/cloudflare/accounts?platform=reddit"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });
});
