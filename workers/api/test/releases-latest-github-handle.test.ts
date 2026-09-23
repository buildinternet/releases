import { describe, it, expect } from "bun:test";
import { organizations, orgAccounts, sources, releases } from "@buildinternet/releases-core/schema";
import { releaseRoutes } from "../src/routes/releases.js";
import { createTestDb, createTestApp } from "./setup";

describe("GET /v1/releases/latest github handle resolution", () => {
  it("resolves the org's earliest-created github handle via the batched lookup", async () => {
    const db = createTestDb();
    await db
      .insert(organizations)
      .values({ id: "org_acme", slug: "acme", name: "Acme", category: "cloud" });
    await db.insert(orgAccounts).values([
      {
        id: "acct_new",
        orgId: "org_acme",
        platform: "github",
        handle: "newer-handle",
        createdAt: "2026-06-05T00:00:00.000Z",
      },
      {
        id: "acct_old",
        orgId: "org_acme",
        platform: "github",
        handle: "older-handle",
        createdAt: "2020-06-30T00:00:00.000Z",
      },
    ]);
    await db.insert(sources).values({
      id: "src_acme_feed",
      slug: "acme-feed",
      name: "Acme Feed",
      type: "feed",
      url: "https://acme.test/feed",
      orgId: "org_acme",
    });
    await db.insert(releases).values({
      id: "rel_acme1",
      sourceId: "src_acme_feed",
      title: "Acme 2.0",
      content: "Notes",
      publishedAt: "2026-06-01T00:00:00Z",
    });

    const app = createTestApp(db, releaseRoutes);
    // Filter by source so the request bypasses the KV latest-cache path
    // (no LATEST_CACHE binding in the test env).
    const res = await app(new Request("http://x/v1/releases/latest?source=acme-feed"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      releases: Array<{ source: { orgGithubHandle: string | null } }>;
    };
    expect(body.releases).toHaveLength(1);
    expect(body.releases[0]!.source.orgGithubHandle).toBe("older-handle");
  });

  it("returns null when the org has no github account", async () => {
    const db = createTestDb();
    await db
      .insert(organizations)
      .values({ id: "org_beta", slug: "beta", name: "Beta", category: "cloud" });
    await db.insert(sources).values({
      id: "src_beta_feed",
      slug: "beta-feed",
      name: "Beta Feed",
      type: "feed",
      url: "https://beta.test/feed",
      orgId: "org_beta",
    });
    await db.insert(releases).values({
      id: "rel_beta1",
      sourceId: "src_beta_feed",
      title: "Beta 1.0",
      content: "Notes",
      publishedAt: "2026-06-01T00:00:00Z",
    });

    const app = createTestApp(db, releaseRoutes);
    const res = await app(new Request("http://x/v1/releases/latest?source=beta-feed"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      releases: Array<{ source: { orgGithubHandle: string | null } }>;
    };
    expect(body.releases).toHaveLength(1);
    expect(body.releases[0]!.source.orgGithubHandle).toBeNull();
  });
});
