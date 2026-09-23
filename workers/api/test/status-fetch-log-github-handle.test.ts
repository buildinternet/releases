import { describe, expect, it } from "bun:test";
import { organizations, orgAccounts, sources, fetchLog } from "@buildinternet/releases-core/schema";
import { statusRoutes } from "../src/routes/status.js";
import { createTestDb as mkDb, createTestApp } from "./setup";

const mkApp = (db: ReturnType<typeof mkDb>) => createTestApp(db, statusRoutes);

describe("GET /v1/status/fetch-log github handle resolution", () => {
  it("resolves the org's earliest-created github handle via the batched lookup", async () => {
    const db = mkDb();
    await db.insert(organizations).values([{ id: "org_gh", slug: "gh-org", name: "GH Org" }]);
    await db.insert(orgAccounts).values([
      {
        id: "acct_new",
        orgId: "org_gh",
        platform: "github",
        handle: "newer-handle",
        createdAt: "2026-06-05T00:00:00.000Z",
      },
      {
        id: "acct_old",
        orgId: "org_gh",
        platform: "github",
        handle: "older-handle",
        createdAt: "2020-06-30T00:00:00.000Z",
      },
    ]);
    await db.insert(sources).values([
      {
        id: "src_gh",
        slug: "changelog",
        name: "Changelog",
        type: "feed",
        url: "https://example.com/changelog",
        orgId: "org_gh",
      },
    ]);
    await db.insert(fetchLog).values([
      {
        id: "fl_1",
        sourceId: "src_gh",
        status: "success",
        releasesFound: 0,
        releasesInserted: 0,
        createdAt: "2026-09-01T00:00:00.000Z",
      },
    ]);

    const res = await mkApp(db)(new Request("http://test/v1/status/fetch-log"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ orgGithubHandle: string | null }> };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]!.orgGithubHandle).toBe("older-handle");
  });

  it("returns null when the org has no github account", async () => {
    const db = mkDb();
    await db.insert(organizations).values([{ id: "org_no_gh", slug: "no-gh", name: "No GH" }]);
    await db.insert(sources).values([
      {
        id: "src_no_gh",
        slug: "changelog",
        name: "Changelog",
        type: "feed",
        url: "https://example.com/changelog",
        orgId: "org_no_gh",
      },
    ]);
    await db.insert(fetchLog).values([
      {
        id: "fl_2",
        sourceId: "src_no_gh",
        status: "success",
        releasesFound: 0,
        releasesInserted: 0,
        createdAt: "2026-09-01T00:00:00.000Z",
      },
    ]);

    const res = await mkApp(db)(new Request("http://test/v1/status/fetch-log"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ orgGithubHandle: string | null }> };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]!.orgGithubHandle).toBeNull();
  });
});
