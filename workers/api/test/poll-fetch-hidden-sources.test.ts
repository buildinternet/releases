/**
 * `queryDueSources` must schedule hidden-but-unpaused sources (#2192). The
 * query is the sole feed for both the poll cron and the SourceActor re-seed
 * heartbeat (`fanOutPollAndFetch`) — a source excluded here never gets its
 * alarm seeded and silently stops ingesting. `is_hidden` is a display lever
 * for public read paths (#1907), not a fetch lever; `fetch_priority =
 * 'paused'` is the fetch lever, and a hidden+paused source must still be
 * excluded via that separate predicate.
 */

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations, ensureBatchShim } from "../../../tests/db-helper";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import { queryDueSources } from "../src/cron/poll-fetch.js";

const NOW = new Date("2026-07-30T12:00:00.000Z");

function mkDb() {
  const sqlite = new Database(":memory:");
  const rawDb = drizzle(sqlite);
  applyMigrations(sqlite);
  return ensureBatchShim(rawDb);
}

describe("queryDueSources — hidden-source scheduling", () => {
  it("includes a hidden, unpaused source; excludes a hidden AND paused source", async () => {
    const db = mkDb();
    await db
      .insert(organizations)
      .values({ id: "org_x", slug: "test-org", name: "Test Org", category: "cloud" });

    // Hidden but not paused — must still be scheduled (this is the bug).
    await db.insert(sources).values({
      id: "src_hidden",
      orgId: "org_x",
      slug: "hidden-src",
      name: "Hidden Source",
      type: "github",
      url: "https://github.com/acme/hidden",
      isHidden: true,
      fetchPriority: "normal",
      lastPolledAt: null,
      nextFetchAfter: null,
    });

    // Hidden AND paused — must be excluded (pausing is still the fetch lever).
    await db.insert(sources).values({
      id: "src_hidden_paused",
      orgId: "org_x",
      slug: "hidden-paused-src",
      name: "Hidden Paused Source",
      type: "github",
      url: "https://github.com/acme/hidden-paused",
      isHidden: true,
      fetchPriority: "paused",
      lastPolledAt: null,
      nextFetchAfter: null,
    });

    // Visible, unpaused control — must be scheduled.
    await db.insert(sources).values({
      id: "src_visible",
      orgId: "org_x",
      slug: "visible-src",
      name: "Visible Source",
      type: "github",
      url: "https://github.com/acme/visible",
      isHidden: false,
      fetchPriority: "normal",
      lastPolledAt: null,
      nextFetchAfter: null,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const due = await queryDueSources(db as any, NOW);
    const ids = due.map((s) => s.id).toSorted();

    expect(ids).toContain("src_hidden");
    expect(ids).toContain("src_visible");
    expect(ids).not.toContain("src_hidden_paused");
    expect(ids).toHaveLength(2);
  });
});
