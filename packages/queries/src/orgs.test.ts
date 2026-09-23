import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { orgAccounts, organizations, releases, sources } from "@buildinternet/releases-core/schema";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { findOrgByAnyIdentifier, listOrgDirectoryPage } from "./orgs.js";

const DELETED_AT = "2026-01-01T00:00:00Z";

describe("org reads", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = createTestDb();
    await tdb.db.insert(organizations).values([
      { id: "org_acme", name: "Acme", slug: "acme", domain: "acme.example.com" },
      { id: "org_shy", name: "Shy", slug: "shy", isHidden: true },
      { id: "org_stub", name: "Stubby", slug: "stubby", tier: "stub" },
      { id: "org_gone", name: "Gone", slug: "gone--org_gone", deletedAt: DELETED_AT },
    ]);
    await tdb.db.insert(orgAccounts).values([
      { id: "oa_acme", orgId: "org_acme", platform: "github", handle: "acme-gh" },
      { id: "oa_gone", orgId: "org_gone", platform: "github", handle: "gone-gh" },
    ]);
    await tdb.db.insert(sources).values(
      ["org_acme", "org_shy", "org_gone"].map((orgId) => ({
        id: `src_${orgId}`,
        orgId,
        name: "Feed",
        slug: "feed",
        type: "feed" as const,
        url: `https://example.com/${orgId}`,
      })),
    );
    await tdb.db.insert(releases).values(
      ["org_acme", "org_shy", "org_gone"].map((orgId) => ({
        id: `rel_${orgId}`,
        sourceId: `src_${orgId}`,
        title: "v1",
        type: "feature" as const,
        content: "x",
      })),
    );
  });
  afterAll(() => tdb.cleanup());

  describe("findOrgByAnyIdentifier", () => {
    it("resolves by id, slug, domain, name, and handle", async () => {
      for (const key of ["org_acme", "acme", "acme.example.com", "ACME", "acme-gh"]) {
        expect((await findOrgByAnyIdentifier(tdb.db, key))?.id).toBe("org_acme");
      }
    });

    it("never resolves a soft-deleted org", async () => {
      for (const key of ["org_gone", "gone--org_gone", "Gone", "gone-gh"]) {
        expect(await findOrgByAnyIdentifier(tdb.db, key)).toBeNull();
      }
    });

    it("resolves a hidden org", async () => {
      expect((await findOrgByAnyIdentifier(tdb.db, "shy"))?.id).toBe("org_shy");
    });
  });

  describe("listOrgDirectoryPage", () => {
    const page = { limit: 50, offset: 0 };

    it("lists orgs with releases plus stubs, never hidden or deleted", async () => {
      const { rows, total } = await listOrgDirectoryPage(tdb.db, page);
      expect(rows.map((r) => r.slug)).toEqual(["acme", "stubby"]);
      expect(total).toBe(2);
    });

    it("query matches account handles but not hidden or deleted orgs", async () => {
      expect((await listOrgDirectoryPage(tdb.db, { ...page, query: "acme-gh" })).total).toBe(1);
      expect((await listOrgDirectoryPage(tdb.db, { ...page, query: "gone" })).total).toBe(0);
      expect((await listOrgDirectoryPage(tdb.db, { ...page, query: "shy" })).total).toBe(0);
    });

    it("platform filter counts distinct orgs", async () => {
      const { rows, total } = await listOrgDirectoryPage(tdb.db, { ...page, platform: "github" });
      expect(rows.map((r) => r.slug)).toEqual(["acme"]);
      expect(total).toBe(1);
    });
  });
});
