import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { sources, organizations } from "@buildinternet/releases-core/schema";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { preserveLiveSourceDataset } from "../src/queries/source-metadata.js";

let h: TestDatabase;
beforeEach(async () => {
  h = createTestDb();
  await h.db.insert(organizations).values({ id: "org_1", name: "Example", slug: "example" });
  await h.db.insert(sources).values({
    orgId: "org_1",
    id: "src_1",
    name: "Feed",
    slug: "feed",
    type: "feed",
    url: "https://example.com",
    metadata: "{}",
  });
});
afterEach(() => h.cleanup());

describe("durable source dataset settings", () => {
  it.each([
    { live: { enabled: false } },
    { live: { enabled: true, name: "Custom" } },
    { live: null },
    { live: "invalid but preserved fail-closed" },
    { live: undefined },
  ])("retains the live dataset key during a stale replacement: %j", async ({ live }) => {
    const stale = JSON.stringify({
      dataset: { enabled: true, name: "Stale" },
      feedEtag: "updated-fetch-header",
    });
    await h.db
      .update(sources)
      .set({ metadata: JSON.stringify(live === undefined ? {} : { dataset: live }) })
      .where(eq(sources.id, "src_1"));
    await h.db
      .update(sources)
      .set({ metadata: preserveLiveSourceDataset(stale) })
      .where(eq(sources.id, "src_1"));
    const row = await h.db.select().from(sources).where(eq(sources.id, "src_1")).get();
    expect(JSON.parse(row!.metadata!)).toEqual({
      ...(live === undefined ? {} : { dataset: live }),
      feedEtag: "updated-fetch-header",
    });
  });
});
