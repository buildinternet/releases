// Exercises the chunked subquery DELETE path on `/v1/orgs/:slug/tags`
// with more tags than a single per-name select/delete loop would handle
// without N round-trips.
import { describe, it, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { organizations, tags, orgTags } from "@buildinternet/releases-core/schema";
import { orgRoutes } from "../src/routes/orgs.js";
import { createTestDb as mkDb, createTestApp } from "./setup";

const mkApp = (db: ReturnType<typeof mkDb>) => createTestApp(db, orgRoutes);

describe("DELETE /v1/orgs/:slug/tags (batched)", () => {
  it("removes >10 tags in a single request", async () => {
    const db = mkDb();
    await db
      .insert(organizations)
      .values({ id: "org_acme", slug: "acme", name: "Acme", category: "cloud" });

    const tagNames = Array.from({ length: 14 }, (_, i) => `tag-${i + 1}`);
    const tagRows = tagNames.map((name, i) => ({
      id: `tag_${i + 1}`,
      name,
      slug: name,
      createdAt: "2026-05-15T00:00:00.000Z",
    }));
    await db.insert(tags).values(tagRows);
    await db
      .insert(orgTags)
      .values(tagRows.map((t) => ({ orgId: "org_acme", tagId: t.id, createdAt: t.createdAt })));

    const fetch = mkApp(db);
    const res = await fetch(
      new Request("http://test/v1/orgs/acme/tags", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tags: tagNames }),
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({ ok: true });

    const remaining = await db.select().from(orgTags).where(eq(orgTags.orgId, "org_acme"));
    expect(remaining).toHaveLength(0);
  });

  it("silently skips tag names that don't resolve to a tag row", async () => {
    const db = mkDb();
    await db
      .insert(organizations)
      .values({ id: "org_acme", slug: "acme", name: "Acme", category: "cloud" });
    await db.insert(tags).values({
      id: "tag_known",
      name: "known",
      slug: "known",
      createdAt: "2026-05-15T00:00:00.000Z",
    });
    await db.insert(orgTags).values({
      orgId: "org_acme",
      tagId: "tag_known",
      createdAt: "2026-05-15T00:00:00.000Z",
    });

    const fetch = mkApp(db);
    const res = await fetch(
      new Request("http://test/v1/orgs/acme/tags", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tags: ["unknown-1", "unknown-2", "known"] }),
      }),
    );
    expect(res.status).toBe(200);

    const remaining = await db.select().from(orgTags).where(eq(orgTags.orgId, "org_acme"));
    expect(remaining).toHaveLength(0);
  });
});
