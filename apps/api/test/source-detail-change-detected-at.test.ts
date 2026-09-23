/**
 * #1969: `GET /v1/sources/:slug` omitted `changeDetectedAt` from the wire
 * payload, so `httpPersister.getSource` (the discovery-worker onboarding
 * path) never saw the flag — `scrape-fetch.ts`'s `finalize` computes
 * `wasFlagged = source.changeDetectedAt != null`, so the #1862 drain signal
 * was always false on that path. This asserts the field round-trips end to
 * end: a source row with `change_detected_at` set → the in-process route →
 * the payload carries it → `httpPersister.getSource` sees it non-null.
 */
import { describe, it, expect } from "bun:test";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import { httpPersister } from "@releases/adapters/scrape-persister";
import { sourceRoutes } from "../src/routes/sources.js";
import { createTestDb, createTestApp } from "./setup";

const SRC_ID = "src_flagged00000000000";
const FLAGGED_AT = "2026-07-01T00:00:00.000Z";

describe("source detail payload: changeDetectedAt (#1969)", () => {
  it("round-trips a non-null changeDetectedAt through httpPersister.getSource", async () => {
    const db = createTestDb();
    await db
      .insert(organizations)
      .values([{ id: "org_flag", slug: "flagorg", name: "Flag Org", category: "developer-tools" }]);
    await db.insert(sources).values([
      {
        id: SRC_ID,
        slug: "flagged-changelog",
        name: "Flagged Changelog",
        type: "scrape",
        url: "https://example.com/changelog",
        orgId: "org_flag",
        changeDetectedAt: FLAGGED_AT,
      },
    ]);

    const handler = createTestApp(db, [sourceRoutes], { env: {} as never });

    // Raw route response carries the field.
    const res = await handler(new Request(`https://api/v1/sources/${SRC_ID}`));
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { changeDetectedAt: string | null };
    expect(payload.changeDetectedAt).toBe(FLAGGED_AT);

    // The httpPersister consumer sees the same non-null value, which is what
    // scrape-fetch.ts's finalize() reads to compute wasFlagged.
    const persister = httpPersister({
      apiFetcher: { fetch: async (input, init) => handler(new Request(input, init)) },
      apiKey: "test-key",
    });
    const source = await persister.getSource(SRC_ID);
    expect(source).not.toBeNull();
    expect(source!.changeDetectedAt).toBe(FLAGGED_AT);
    expect(source!.changeDetectedAt != null).toBe(true);
  });

  it("returns null (not undefined) when unflagged", async () => {
    const db = createTestDb();
    await db
      .insert(organizations)
      .values([
        { id: "org_unflag", slug: "unflagorg", name: "Unflag Org", category: "developer-tools" },
      ]);
    await db.insert(sources).values([
      {
        id: "src_unflagged0000000000",
        slug: "unflagged-changelog",
        name: "Unflagged Changelog",
        type: "scrape",
        url: "https://example.com/changelog",
        orgId: "org_unflag",
      },
    ]);

    const handler = createTestApp(db, [sourceRoutes], { env: {} as never });
    const res = await handler(new Request("https://api/v1/sources/src_unflagged0000000000"));
    const payload = (await res.json()) as { changeDetectedAt: string | null };
    expect(payload.changeDetectedAt).toBeNull();
  });
});
