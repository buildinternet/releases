/**
 * #2171 item 3: `buildEnrichMap` (workers/api/src/cron/poll-fetch.ts) used to
 * skip enrichment silently in every case — flag off, no usable model, or the
 * source simply isn't `feedContentDepth: "summary-only"` — returning an empty
 * map with no diagnostic. That silence is what let the manual-fetch route's
 * env drop (this issue) sit undetected: nothing distinguished "working as
 * intended" from "quietly broken."
 *
 * These tests exercise `buildEnrichMap` through the exported `ingestRawReleases`
 * (the only way to reach the private function) and assert it now emits a
 * `feed-enrich-skip` event distinguishing "flag-off" from "no-usable-model" —
 * captured via the underlying console.log/warn `logEvent` writes to, not via a
 * mocked logger (worker code has no logger seam to inject).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { applyMigrations, ensureBatchShim } from "../../../tests/db-helper";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import type { D1Db } from "../src/db.js";
import { ingestRawReleases, type FetchOneEnv } from "../src/cron/poll-fetch.js";
import type { RawRelease } from "@releases/adapters/types";
import type { Source } from "@buildinternet/releases-core/schema";

function mkDb(): D1Db {
  const sqlite = new Database(":memory:");
  const rawDb = drizzle(sqlite);
  applyMigrations(sqlite);
  return ensureBatchShim(rawDb) as unknown as D1Db;
}

async function seedSource(db: D1Db, metadata: Record<string, unknown>): Promise<Source> {
  await db
    .insert(organizations)
    .values({ id: "org_a", slug: "acme", name: "Acme", category: "cloud" });
  await db.insert(sources).values({
    id: "src_a1",
    orgId: "org_a",
    slug: "acme-one",
    name: "Acme One",
    url: "https://a.test/changelog",
    type: "feed",
    metadata: JSON.stringify(metadata),
  });
  const [src] = await db.select().from(sources).where(eq(sources.id, "src_a1"));
  return src as unknown as Source;
}

function mkRaw(url: string): RawRelease {
  return { title: "Thin release", content: "short body", url, publishedAt: new Date("2026-01-01") };
}

let logs: Array<{ level: string; payload: Record<string, unknown> }> = [];
const realLog = console.log;
const realWarn = console.warn;

beforeEach(() => {
  logs = [];
  console.log = (line: string) => {
    logs.push({ level: "info", payload: JSON.parse(line) });
  };
  console.warn = (line: string) => {
    logs.push({ level: "warn", payload: JSON.parse(line) });
  };
});

afterEach(() => {
  console.log = realLog;
  console.warn = realWarn;
});

function skipEvents() {
  return logs.filter((l) => l.payload.event === "feed-enrich-skip");
}

describe("buildEnrichMap skip diagnostics (#2171)", () => {
  it("logs reason=flag-off when FEED_ENRICH_ENABLED is unset (the manual-fetch route's pre-fix state)", async () => {
    const db = mkDb();
    const src = await seedSource(db, { feedContentDepth: "summary-only" });
    const env: FetchOneEnv = {} as FetchOneEnv; // no FLAGS, no FEED_ENRICH_ENABLED, no AI keys

    await ingestRawReleases(db, src, [mkRaw("https://a.test/thin-1")], env);

    const events = skipEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.reason).toBe("flag-off");
    expect(events[0]!.payload.sourceId).toBe("src_a1");
  });

  it("logs reason=no-usable-model when the flag is on but no provider key resolves", async () => {
    const db = mkDb();
    const src = await seedSource(db, { feedContentDepth: "summary-only" });
    const env: FetchOneEnv = { FEED_ENRICH_ENABLED: "true" } as FetchOneEnv;

    await ingestRawReleases(db, src, [mkRaw("https://a.test/thin-2")], env);

    const events = skipEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.reason).toBe("no-usable-model");
    expect(events[0]!.payload.sourceId).toBe("src_a1");
  });

  it("does not log a skip event for sources that simply aren't summary-only (the common, non-broken case)", async () => {
    const db = mkDb();
    const src = await seedSource(db, {});
    const env: FetchOneEnv = { FEED_ENRICH_ENABLED: "true" } as FetchOneEnv;

    await ingestRawReleases(db, src, [mkRaw("https://a.test/thin-3")], env);

    expect(skipEvents()).toHaveLength(0);
  });
});
