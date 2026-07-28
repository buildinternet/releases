/**
 * Tests for the provider-health digest scan (#2168): flag sources whose MOST
 * RECENT ingest attempt failed because the AI provider itself is cut off
 * (spend cap / billing shutoff), as opposed to an ordinary transient error or
 * simply having no new releases. Feeds the staleness digest email — see
 * `send-staleness-digest.ts` / `staleness-digest-email.ts`.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations, ensureBatchShim } from "../../../tests/db-helper.js";
import { organizations, sources, fetchLog } from "@buildinternet/releases-core/schema";

const { scanProviderHealth } = await import("../src/cron/provider-health.js");

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const HOUR = 3600_000;
const DAY = 24 * HOUR;

const QUOTA_MESSAGE =
  "You have reached your specified API usage limits. You will regain access on 2026-08-01 at 00:00 UTC.";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let logCounter = 0;

beforeEach(() => {
  const sqlite = new Database(":memory:");
  db = ensureBatchShim(drizzle(sqlite));
  applyMigrations(sqlite);
  db.insert(organizations).values({ id: "org_1", name: "Acme", slug: "acme" }).run();
  logCounter = 0;
});

function seedSource(opts: {
  id: string;
  fetchPriority?: "normal" | "low" | "paused";
  lastFetchedAt?: string | null;
  deletedAt?: string | null;
}) {
  db.insert(sources)
    .values({
      id: opts.id,
      orgId: "org_1",
      name: opts.id,
      slug: opts.id,
      type: "scrape",
      url: `https://example.com/${opts.id}`,
      fetchPriority: opts.fetchPriority ?? "normal",
      lastFetchedAt: opts.lastFetchedAt ?? null,
      deletedAt: opts.deletedAt ?? null,
    })
    .run();
}

function seedLog(opts: {
  sourceId: string;
  status: "success" | "error" | "no_change" | "dry_run";
  createdAt: string;
  error?: string | null;
}) {
  db.insert(fetchLog)
    .values({
      id: `fl_${++logCounter}`,
      sourceId: opts.sourceId,
      status: opts.status,
      releasesFound: 0,
      releasesInserted: 0,
      error: opts.error ?? null,
      createdAt: opts.createdAt,
    })
    .run();
}

const baseEnv = () => ({ DB: {} as never, _drizzleOverride: db });

describe("scanProviderHealth", () => {
  it("flags a source whose latest attempt is a provider quota shutoff", async () => {
    seedSource({ id: "broken", lastFetchedAt: iso(2 * DAY) });
    seedLog({
      sourceId: "broken",
      status: "error",
      createdAt: iso(1 * HOUR),
      error: QUOTA_MESSAGE,
    });

    const res = await scanProviderHealth(baseEnv());
    expect(res.broken).toBe(1);
    expect(res.entries).toHaveLength(1);
    // `fetch_log.error` stores only the provider's message text (no
    // structured provider id survives that round trip), and the verbatim
    // 2026-07-23 outage message names no provider — so `providerOf` falls
    // back to "unknown" here. That's the real, honest signal this scan can
    // give from stored text alone.
    expect(res.entries[0]).toMatchObject({
      sourceId: "broken",
      provider: "unknown",
      regainAccessAt: "2026-08-01T00:00:00.000Z",
    });
  });

  it("does not flag a healthy source with a recent successful evaluation and no new releases", async () => {
    // A recent last_fetched_at plus a `no_change` most-recent attempt is
    // "no news", not "broken" — must never appear in this scan.
    seedSource({ id: "quiet", lastFetchedAt: iso(1 * HOUR) });
    seedLog({ sourceId: "quiet", status: "no_change", createdAt: iso(1 * HOUR) });

    const res = await scanProviderHealth(baseEnv());
    expect(res.broken).toBe(0);
    expect(res.entries).toHaveLength(0);
  });

  it("does not flag an ordinary (non-quota) error, even repeated", async () => {
    seedSource({ id: "flaky", lastFetchedAt: iso(3 * DAY) });
    seedLog({ sourceId: "flaky", status: "error", createdAt: iso(2 * HOUR), error: "boom" });
    seedLog({
      sourceId: "flaky",
      status: "error",
      createdAt: iso(1 * HOUR),
      error: "ETIMEDOUT connecting to origin",
    });

    const res = await scanProviderHealth(baseEnv());
    expect(res.broken).toBe(0);
  });

  it("does not flag a retryable per-minute rate limit, even worded like a quota message", async () => {
    seedSource({ id: "rate-limited", lastFetchedAt: iso(1 * DAY) });
    seedLog({
      sourceId: "rate-limited",
      status: "error",
      createdAt: iso(1 * HOUR),
      error: "quota exceeded for this minute; retry after 30 seconds",
    });

    const res = await scanProviderHealth(baseEnv());
    expect(res.broken).toBe(0);
  });

  it("recovers once a later attempt succeeds after a quota shutoff", async () => {
    seedSource({ id: "recovered", lastFetchedAt: iso(1 * HOUR) });
    seedLog({
      sourceId: "recovered",
      status: "error",
      createdAt: iso(2 * HOUR),
      error: QUOTA_MESSAGE,
    });
    // A later successful attempt is the source's newest fetch_log row now.
    seedLog({ sourceId: "recovered", status: "success", createdAt: iso(1 * HOUR) });

    const res = await scanProviderHealth(baseEnv());
    expect(res.broken).toBe(0);
  });

  it("excludes paused and deleted sources", async () => {
    seedSource({ id: "paused", fetchPriority: "paused", lastFetchedAt: iso(3 * DAY) });
    seedLog({
      sourceId: "paused",
      status: "error",
      createdAt: iso(1 * HOUR),
      error: QUOTA_MESSAGE,
    });

    seedSource({ id: "deleted", deletedAt: iso(1 * DAY), lastFetchedAt: iso(3 * DAY) });
    seedLog({
      sourceId: "deleted",
      status: "error",
      createdAt: iso(1 * HOUR),
      error: QUOTA_MESSAGE,
    });

    const res = await scanProviderHealth(baseEnv());
    expect(res.broken).toBe(0);
  });

  it("ignores dry_run rows when picking the latest attempt", async () => {
    seedSource({ id: "src", lastFetchedAt: iso(2 * DAY) });
    seedLog({
      sourceId: "src",
      status: "error",
      createdAt: iso(2 * HOUR),
      error: QUOTA_MESSAGE,
    });
    // A dry-run probe after the quota failure must not mask it.
    seedLog({ sourceId: "src", status: "dry_run", createdAt: iso(1 * HOUR) });

    const res = await scanProviderHealth(baseEnv());
    expect(res.broken).toBe(1);
  });

  it("no-ops when CRON_ENABLED is false", async () => {
    seedSource({ id: "src", lastFetchedAt: iso(2 * DAY) });
    seedLog({ sourceId: "src", status: "error", createdAt: iso(1 * HOUR), error: QUOTA_MESSAGE });

    const res = await scanProviderHealth({ ...baseEnv(), CRON_ENABLED: "false" });
    expect(res).toEqual({ scanned: 0, broken: 0, entries: [] });
  });

  it("fails open when the DB handle is broken", async () => {
    const brokenDb = {
      all: async () => {
        throw new Error("db unavailable");
      },
    };
    const res = await scanProviderHealth({ DB: {} as never, _drizzleOverride: brokenDb });
    expect(res).toEqual({ scanned: 0, broken: 0, entries: [] });
  });
});
