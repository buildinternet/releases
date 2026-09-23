import { describe, expect, test } from "bun:test";
import { createTestDb } from "../../../../tests/db-helper";
import { organizations, orgAccounts } from "@buildinternet/releases-core/schema";
import { loadOrgGithubHandles } from "./shared";

async function seedOrg(db: ReturnType<typeof createTestDb>["db"], id: string) {
  await db.insert(organizations).values({ id, name: id, slug: id });
}

describe("loadOrgGithubHandles", () => {
  test("picks the earliest-created github handle per org", async () => {
    const { db } = createTestDb();
    await seedOrg(db, "org_a");
    await db.insert(orgAccounts).values([
      {
        id: "acct_new",
        orgId: "org_a",
        platform: "github",
        handle: "newer",
        createdAt: "2026-06-05T00:00:00.000Z",
      },
      {
        id: "acct_old",
        orgId: "org_a",
        platform: "github",
        handle: "older",
        createdAt: "2020-06-30T00:00:00.000Z",
      },
    ]);

    const handles = await loadOrgGithubHandles(db, ["org_a"]);

    expect(handles.get("org_a")).toBe("older");
  });

  test("breaks a created_at tie with id ascending", async () => {
    const { db } = createTestDb();
    await seedOrg(db, "org_b");
    const sameTimestamp = "2026-01-01T00:00:00.000Z";
    await db.insert(orgAccounts).values([
      {
        id: "acct_zzz",
        orgId: "org_b",
        platform: "github",
        handle: "from-zzz",
        createdAt: sameTimestamp,
      },
      {
        id: "acct_aaa",
        orgId: "org_b",
        platform: "github",
        handle: "from-aaa",
        createdAt: sameTimestamp,
      },
    ]);

    const handles = await loadOrgGithubHandles(db, ["org_b"]);

    expect(handles.get("org_b")).toBe("from-aaa");
  });

  test("ignores non-github platforms", async () => {
    const { db } = createTestDb();
    await seedOrg(db, "org_c");
    await db.insert(orgAccounts).values([
      { id: "acct_x", orgId: "org_c", platform: "x", handle: "on-x" },
      { id: "acct_reddit", orgId: "org_c", platform: "reddit", handle: "on-reddit" },
    ]);

    const handles = await loadOrgGithubHandles(db, ["org_c"]);

    expect(handles.has("org_c")).toBe(false);
  });

  test("omits an org with no linked account from the map", async () => {
    const { db } = createTestDb();
    await seedOrg(db, "org_d");

    const handles = await loadOrgGithubHandles(db, ["org_d"]);

    expect(handles.has("org_d")).toBe(false);
    expect(handles.get("org_d")).toBeUndefined();
  });

  test("returns an empty map for an empty input", async () => {
    const { db } = createTestDb();

    const handles = await loadOrgGithubHandles(db, []);

    expect(handles.size).toBe(0);
  });

  test("chunks lookups past the 90-id D1 bound-param boundary", async () => {
    const { db } = createTestDb();
    const orgIds = Array.from({ length: 95 }, (_, i) => `org_bulk_${i}`);
    await db.insert(organizations).values(orgIds.map((id) => ({ id, name: id, slug: id })));
    await db.insert(orgAccounts).values(
      orgIds.map((orgId, i) => ({
        id: `acct_bulk_${i}`,
        orgId,
        platform: "github",
        handle: `handle-${i}`,
      })),
    );

    const handles = await loadOrgGithubHandles(db, orgIds);

    expect(handles.size).toBe(95);
    expect(handles.get("org_bulk_0")).toBe("handle-0");
    expect(handles.get("org_bulk_94")).toBe("handle-94");
  });
});
