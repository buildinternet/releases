/**
 * `getSourcesWithStats` reads counts and latest dates from
 * `source_release_stats` and computes `latest_version` for the returned page
 * only. These pin the list's stats columns to what `releases_visible` says.
 */
import { describe, it, expect } from "bun:test";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { createTestDb } from "../../../tests/db-helper.js";
import { getSourcesWithStats } from "../src/queries/sources.js";
import type { D1Db } from "../src/db.js";

const NOW = "2026-11-10T00:00:00.000Z";

async function setup() {
  const { db } = createTestDb();
  await db.insert(organizations).values({ id: "org_a", slug: "acme", name: "Acme" });
  await db.insert(sources).values(
    ["src_a", "src_b", "src_c"].map((id) => ({
      id,
      orgId: "org_a",
      slug: id,
      name: id,
      type: "github" as const,
      url: `https://${id}.test`,
      createdAt: NOW,
    })),
  );
  let n = 0;
  const rel = (
    sourceId: string,
    version: string | null,
    versionSort: string | null,
    publishedAt: string | null,
    extra: Record<string, unknown> = {},
  ) =>
    db.insert(releases).values({
      id: `rel_${++n}`,
      sourceId,
      title: version ?? "untitled",
      version,
      versionSort,
      content: "",
      url: `https://${sourceId}.test/${n}`,
      publishedAt,
      fetchedAt: NOW,
      ...extra,
    });
  return { db: db as unknown as D1Db, rel };
}

describe("getSourcesWithStats", () => {
  it("reports visible counts, latest date and the highest-sorting version", async () => {
    const { db, rel } = await setup();
    // src_a: v16 is the current major; a later v15 backport must not win.
    await rel("src_a", "v16.0.0", "0016.0000.0000", "2026-10-01");
    await rel("src_a", "v15.5.18", "0015.0005.0018", "2026-10-20");
    await rel("src_a", "v17.0.0", "0017.0000.0000", "2026-10-25", { suppressed: 1 });
    // src_b: no version_sort, so the latest-published row's version wins.
    await rel("src_b", "2026.09", null, "2026-09-01");
    await rel("src_b", "2026.10", null, "2026-10-01");
    // src_c: no releases.

    const rows = await getSourcesWithStats(db, undefined, { sort: "name", dir: "asc" });
    const byId = Object.fromEntries(
      rows.map((r) => [r.id, [r.release_count, r.latest_date, r.latest_version]]),
    );
    expect(byId).toEqual({
      src_a: [2, "2026-10-20", "v16.0.0"],
      src_b: [2, "2026-10-01", "2026.10"],
      src_c: [0, null, null],
    });
  });

  it("sorts by latest date and paginates before computing versions", async () => {
    const { db, rel } = await setup();
    await rel("src_a", "1.0.0", "0001.0000.0000", "2026-01-01");
    await rel("src_b", "2.0.0", "0002.0000.0000", "2026-06-01");
    const rows = await getSourcesWithStats(db, undefined, {
      sort: "latest_date",
      dir: "desc",
      limit: 1,
    });
    expect(rows.map((r) => [r.id, r.latest_version])).toEqual([["src_b", "2.0.0"]]);
  });

  it("filters stale sources from the rollup's latest date", async () => {
    const { db, rel } = await setup();
    await rel("src_a", "1.0.0", null, new Date().toISOString());
    await rel("src_b", "1.0.0", null, "2020-01-01");
    const rows = await getSourcesWithStats(db, undefined, { staleOnly: true });
    expect(rows.map((r) => r.id).toSorted()).toEqual(["src_b", "src_c"]);
  });
});
