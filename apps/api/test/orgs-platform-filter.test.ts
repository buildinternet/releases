// `?platform=` on the orgs list: keeps orgs with a linked account on that
// platform (`org_accounts.platform`), case-insensitively, and scopes the
// pagination count to the same filter.
import { describe, it, expect } from "bun:test";
import { organizations, orgAccounts, sources, releases } from "@buildinternet/releases-core/schema";
import { orgRoutes } from "../src/routes/orgs.js";
import { createTestDb as mkDb, createTestApp } from "./setup";

const mkApp = (db: ReturnType<typeof mkDb>) => createTestApp(db, orgRoutes);

const NOW = "2026-05-30T12:00:00.000Z";

async function seed(db: ReturnType<typeof mkDb>) {
  await db.insert(organizations).values([
    { id: "org_gh", slug: "gh-co", name: "GitHub Co" },
    { id: "org_x", slug: "x-co", name: "X Co" },
    { id: "org_none", slug: "none-co", name: "None Co" },
  ]);
  await db.insert(orgAccounts).values([
    { orgId: "org_gh", platform: "github", handle: "gh-co" },
    { orgId: "org_x", platform: "x", handle: "xco" },
  ]);
  await db.insert(sources).values(
    ["org_gh", "org_x", "org_none"].map((orgId) => ({
      id: `src_${orgId}`,
      orgId,
      slug: `${orgId}-changelog`,
      name: "Changelog",
      type: "scrape" as const,
      url: `https://${orgId}.example/changelog`,
      createdAt: NOW,
    })),
  );
  await db.insert(releases).values(
    ["org_gh", "org_x", "org_none"].map((orgId) => ({
      id: `rel_${orgId}`,
      sourceId: `src_${orgId}`,
      title: "1.0",
      content: "Initial release",
      publishedAt: NOW,
      fetchedAt: NOW,
    })),
  );
}

type ListBody = { items: Array<{ slug: string }>; pagination: { totalItems: number } };

async function list(db: ReturnType<typeof mkDb>, qs: string): Promise<ListBody> {
  const res = await mkApp(db)(new Request(`https://x.test/v1/orgs${qs}`));
  expect(res.status).toBe(200);
  return (await res.json()) as ListBody;
}

describe("GET /v1/orgs — platform filter", () => {
  it("keeps only orgs with an account on the platform", async () => {
    const db = mkDb();
    await seed(db);
    const body = await list(db, "?platform=github");
    expect(body.items.map((o) => o.slug)).toEqual(["gh-co"]);
    expect(body.pagination.totalItems).toBe(1);
  });

  it("matches the platform case-insensitively", async () => {
    const db = mkDb();
    await seed(db);
    const body = await list(db, "?platform=GitHub");
    expect(body.items.map((o) => o.slug)).toEqual(["gh-co"]);
  });

  it("returns no orgs for a platform nobody has", async () => {
    const db = mkDb();
    await seed(db);
    const body = await list(db, "?platform=mastodon");
    expect(body.items).toEqual([]);
    expect(body.pagination.totalItems).toBe(0);
  });

  it("is unfiltered without the param", async () => {
    const db = mkDb();
    await seed(db);
    const body = await list(db, "");
    expect(body.items).toHaveLength(3);
  });
});
