import { describe, it, expect } from "bun:test";
import { organizations, sources, sourcesVisible } from "@buildinternet/releases-core/schema";
import { eq } from "drizzle-orm";
import { createTestDb } from "./setup";

describe("sources stargazers columns", () => {
  it("stores stargazers_count and surfaces it through sources_visible", async () => {
    const db = createTestDb();
    await db.insert(organizations).values({ id: "org_a", slug: "acme", name: "Acme" });
    await db.insert(sources).values({
      id: "src_g",
      slug: "widget",
      name: "widget",
      type: "github",
      url: "https://github.com/acme/widget",
      orgId: "org_a",
      stargazersCount: 4321,
      starsFetchedAt: "2026-06-02T00:00:00.000Z",
    });

    const [row] = await db.select().from(sourcesVisible).where(eq(sourcesVisible.id, "src_g"));

    expect(row?.stargazersCount).toBe(4321);
    expect(row?.starsFetchedAt).toBe("2026-06-02T00:00:00.000Z");
  });
});
