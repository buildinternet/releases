import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { applyMigrations, ensureBatchShim } from "../../../tests/db-helper";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import type { D1Db } from "../src/db.js";
import { Hono } from "hono";
import {
  fetchLogRoutes,
  shouldBackoffScrapeFailure,
  failureBackoffHours,
} from "../src/routes/fetch-log.js";

function mkDb(): D1Db {
  const sqlite = new Database(":memory:");
  const rawDb = drizzle(sqlite);
  applyMigrations(sqlite);
  return ensureBatchShim(rawDb) as unknown as D1Db;
}

async function seedSource(db: D1Db, overrides: Record<string, unknown> = {}) {
  await db
    .insert(organizations)
    .values({ id: "org_a", slug: "acme", name: "Acme", category: "cloud" });
  await db.insert(sources).values({
    id: "src_a1",
    orgId: "org_a",
    slug: "acme-one",
    name: "Acme One",
    url: "https://a.test/changelog",
    type: "scrape",
    ...overrides,
  });
}

function mkApp(db: D1Db) {
  // No STATUS_HUB — the backoff side-effect must not depend on the dashboard DO.
  const fakeEnv = { DB: db };
  const app = new Hono();
  const v1 = new Hono();
  v1.route("/", fetchLogRoutes);
  app.route("/v1", v1);
  return async (req: Request) => app.fetch(req, fakeEnv as never);
}

function postLog(fetch: (req: Request) => Promise<Response>, body: Record<string, unknown>) {
  return fetch(
    new Request("https://x.test/v1/admin/logs/fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceId: "src_a1",
        releasesFound: 0,
        releasesInserted: 0,
        durationMs: 100,
        ...body,
      }),
    }),
  );
}

async function readSource(db: D1Db) {
  const [row] = await db
    .select({
      consecutiveErrors: sources.consecutiveErrors,
      nextFetchAfter: sources.nextFetchAfter,
      fetchPriority: sources.fetchPriority,
    })
    .from(sources)
    .where(eq(sources.id, "src_a1"));
  return row;
}

describe("fetch-log backoff — pure helpers", () => {
  it("only backs off deterministic, non-self-resolving categories", () => {
    expect(shouldBackoffScrapeFailure("model")).toBe(true);
    expect(shouldBackoffScrapeFailure("bot_challenge")).toBe(true);
    // Transient / unknown categories are excluded so a healthy source isn't
    // throttled by a one-off render blip.
    expect(shouldBackoffScrapeFailure("infra")).toBe(false);
    expect(shouldBackoffScrapeFailure("unknown")).toBe(false);
    expect(shouldBackoffScrapeFailure(null)).toBe(false);
    expect(shouldBackoffScrapeFailure(undefined)).toBe(false);
  });

  it("grows the backoff exponentially and caps at 72h", () => {
    expect(failureBackoffHours(1)).toBe(1);
    expect(failureBackoffHours(2)).toBe(2);
    expect(failureBackoffHours(3)).toBe(4);
    expect(failureBackoffHours(6)).toBe(32);
    expect(failureBackoffHours(8)).toBe(72); // 2^7=128 capped
    expect(failureBackoffHours(20)).toBe(72);
  });
});

describe("POST /v1/admin/logs/fetch — deterministic-failure backoff (#1851)", () => {
  it("bumps consecutive_errors and sets ~1h next_fetch_after on a maxed-output (model) failure", async () => {
    const db = mkDb();
    await seedSource(db);
    const fetch = mkApp(db);

    const before = Date.now();
    const res = await postLog(fetch, {
      status: "error",
      errorCategory: "model",
      error: "max_tokens",
    });
    expect(res.status).toBe(201);

    const row = await readSource(db);
    expect(row.consecutiveErrors).toBe(1);
    expect(row.fetchPriority).toBe("normal");
    expect(row.nextFetchAfter).not.toBeNull();
    const next = new Date(row.nextFetchAfter as string).getTime();
    // First error → 1h backoff.
    expect(next).toBeGreaterThan(before);
    expect(next).toBeLessThanOrEqual(before + 1.05 * 3600_000);
  });

  it("does NOT back off transient / uncategorized failures", async () => {
    const db = mkDb();
    await seedSource(db);
    const fetch = mkApp(db);

    await postLog(fetch, { status: "error", errorCategory: "infra", error: "render blip" });
    let row = await readSource(db);
    expect(row.consecutiveErrors).toBe(0);
    expect(row.nextFetchAfter).toBeNull();

    // A plain error with no category (generic extraction failure) is also left alone.
    await postLog(fetch, { status: "error" });
    row = await readSource(db);
    expect(row.consecutiveErrors).toBe(0);
    expect(row.nextFetchAfter).toBeNull();
  });

  it("does NOT back off a successful / no_change log", async () => {
    const db = mkDb();
    await seedSource(db);
    const fetch = mkApp(db);

    await postLog(fetch, { status: "no_change" });
    const row = await readSource(db);
    expect(row.consecutiveErrors).toBe(0);
    expect(row.nextFetchAfter).toBeNull();
    expect(row.fetchPriority).toBe("normal");
  });

  it("auto-pauses a source after crossing the consecutive-error threshold", async () => {
    const db = mkDb();
    // Pre-seed one below the pause threshold (6) so a single further failure trips it.
    await seedSource(db, { consecutiveErrors: 5 });
    const fetch = mkApp(db);

    const res = await postLog(fetch, {
      status: "blocked",
      errorCategory: "bot_challenge",
      error: "interstitial",
    });
    expect(res.status).toBe(201);

    const row = await readSource(db);
    expect(row.consecutiveErrors).toBe(6);
    expect(row.fetchPriority).toBe("paused");
  });
});
