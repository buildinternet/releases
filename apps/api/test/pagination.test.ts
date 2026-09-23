import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Hono } from "hono";
import { applyMigrations } from "../../../tests/db-helper";
import {
  blockedUrls,
  ignoredUrls,
  orgAccounts,
  organizations,
  orgTags,
  products,
  tags,
} from "@buildinternet/releases-core/schema";
import { buildSessionListResponse } from "../src/status-hub.js";
import { orgRoutes } from "../src/routes/orgs.js";
import { ignoreRoutes } from "../src/routes/ignore.js";
import { productRoutes } from "../src/routes/products.js";

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
  v1.route("/", productRoutes);
  v1.route("/", ignoreRoutes);
  app.route("/v1", v1);

  const fakeEnv = { DB: db };
  const fakeCtx = {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  return (req: Request) => app.fetch(req, fakeEnv, fakeCtx);
}

const NOW = 1_735_000_000_000;

describe("API list pagination", () => {
  it("returns org lists in the shared pagination envelope", async () => {
    const db = mkDb();
    await db.insert(organizations).values([
      { id: "org_acme", name: "Acme", slug: "acme" },
      { id: "org_beta", name: "Beta", slug: "beta" },
      { id: "org_cyan", name: "Cyan", slug: "cyan" },
    ]);

    // These fixtures have no sources/releases, so the default empty-org
    // filter (#746) would hide them. This test only cares about the
    // pagination envelope shape — opt in explicitly.
    const res = await mkApp(db)(
      new Request("https://x.test/v1/orgs?limit=2&page=2&includeEmpty=true"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ id: string; name: string }>;
      pagination: {
        page: number;
        pageSize: number;
        returned: number;
        totalItems: number;
        hasMore: boolean;
      };
    };

    expect(body.items.map((org) => org.name)).toEqual(["Cyan"]);
    expect(body.pagination).toMatchObject({
      page: 2,
      pageSize: 2,
      returned: 1,
      totalItems: 3,
      hasMore: false,
    });
  });

  it("paginates sessions after applying status/type filters", () => {
    const response = buildSessionListResponse(
      [
        {
          sessionId: "sesn_a",
          company: "Acme",
          type: "onboard",
          status: "running",
          startedAt: NOW - 60_000,
          lastUpdatedAt: NOW - 60_000,
        },
        {
          sessionId: "sesn_b",
          company: "Beta",
          type: "onboard",
          status: "complete",
          startedAt: NOW - 120_000,
          lastUpdatedAt: NOW - 120_000,
        },
        {
          sessionId: "sesn_c",
          company: "Cyan",
          type: "update",
          status: "running",
          startedAt: NOW - 180_000,
          lastUpdatedAt: NOW - 180_000,
        },
      ],
      new URLSearchParams("type=onboard&limit=1&page=2"),
      NOW,
    );

    expect(response.items.map((session) => session.sessionId)).toEqual(["sesn_b"]);
    expect(response.pagination).toMatchObject({
      page: 2,
      pageSize: 1,
      returned: 1,
      totalItems: 2,
      hasMore: false,
    });
  });

  it("keeps single ignored-url lookups raw but paginates list responses", async () => {
    const db = mkDb();
    await db.insert(organizations).values({ id: "org_acme", name: "Acme", slug: "acme" });
    await db.insert(ignoredUrls).values([
      {
        id: "ign_older",
        orgId: "org_acme",
        url: "https://example.com/older",
        ignoredAt: "2026-05-01T00:00:00.000Z",
      },
      {
        id: "ign_newer",
        orgId: "org_acme",
        url: "https://example.com/newer",
        ignoredAt: "2026-05-02T00:00:00.000Z",
      },
    ]);

    const fetch = mkApp(db);
    const listRes = await fetch(
      new Request("https://x.test/v1/orgs/acme/ignored-urls?limit=1&page=2"),
    );
    const listBody = (await listRes.json()) as {
      items: Array<{ id: string }>;
      pagination: { totalItems: number; returned: number };
    };
    expect(listBody.items.map((row) => row.id)).toEqual(["ign_older"]);
    expect(listBody.pagination).toMatchObject({ totalItems: 2, returned: 1 });

    const singleRes = await fetch(
      new Request(
        "https://x.test/v1/orgs/acme/ignored-urls?single=true&url=https%3A%2F%2Fexample.com%2Fnewer",
      ),
    );
    expect(((await singleRes.json()) as { id: string }).id).toBe("ign_newer");
  });

  it("uses the same envelope for blocklist and swept org sublists", async () => {
    const db = mkDb();
    await db.insert(organizations).values({ id: "org_acme", name: "Acme", slug: "acme" });
    await db.insert(blockedUrls).values([
      {
        id: "blk_older",
        pattern: "older.example.com",
        type: "domain",
        createdAt: "2026-05-01T00:00:00.000Z",
      },
      {
        id: "blk_newer",
        pattern: "newer.example.com",
        type: "domain",
        createdAt: "2026-05-02T00:00:00.000Z",
      },
    ]);
    await db.insert(orgAccounts).values([
      { id: "acct_gh", orgId: "org_acme", platform: "github", handle: "acme" },
      { id: "acct_x", orgId: "org_acme", platform: "x", handle: "acme" },
    ]);
    await db.insert(tags).values([
      { id: "tag_ai", name: "AI", slug: "ai" },
      { id: "tag_cloud", name: "Cloud", slug: "cloud" },
    ]);
    await db.insert(orgTags).values([
      { orgId: "org_acme", tagId: "tag_ai" },
      { orgId: "org_acme", tagId: "tag_cloud" },
    ]);
    await db.insert(products).values([
      { id: "prod_alpha", orgId: "org_acme", name: "Alpha", slug: "alpha" },
      { id: "prod_beta", orgId: "org_acme", name: "Beta", slug: "beta" },
    ]);

    const fetch = mkApp(db);
    const blocklist = (await (
      await fetch(new Request("https://x.test/v1/admin/blocklist?limit=1&page=2"))
    ).json()) as { items: Array<{ id: string }>; pagination: { totalItems: number } };
    expect(blocklist.items.map((row) => row.id)).toEqual(["blk_older"]);
    expect(blocklist.pagination.totalItems).toBe(2);

    const accounts = (await (
      await fetch(new Request("https://x.test/v1/orgs/acme/accounts?limit=1&page=2"))
    ).json()) as { items: Array<{ platform: string }> };
    expect(accounts.items.map((row) => row.platform)).toEqual(["x"]);

    const tagList = (await (
      await fetch(new Request("https://x.test/v1/orgs/acme/tags?limit=1&page=2"))
    ).json()) as { items: string[] };
    expect(tagList.items).toEqual(["Cloud"]);

    const productList = (await (
      await fetch(new Request("https://x.test/v1/products?orgId=org_acme&limit=1&page=2"))
    ).json()) as { items: Array<{ id: string }> };
    expect(productList.items.map((row) => row.id)).toEqual(["prod_beta"]);
  });
});
