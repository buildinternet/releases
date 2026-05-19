import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations } from "../db-helper";
import { fetchLog, organizations, sources } from "@buildinternet/releases-core/schema";
import type { Session } from "@buildinternet/releases-api-types";
import {
  applyFetchLogOverlay,
  applyFetchLogOverlaySingle,
} from "../../workers/api/src/lib/session-fetch-log-overlay";

function mkDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  applyMigrations(sqlite);
  db.insert(organizations)
    .values([{ id: "org_a", name: "Org A", slug: "a", category: "developer-tools" }])
    .run();
  db.insert(sources)
    .values([
      {
        id: "src_a1",
        name: "A1",
        slug: "a-1",
        type: "scrape",
        url: "https://a.example/1",
        orgId: "org_a",
        metadata: "{}",
      },
    ])
    .run();
  return db;
}

function mkSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: "ma-1",
    company: "A",
    type: "update",
    status: "error",
    error: "Network connection lost",
    errorSource: "us",
    startedAt: 0,
    lastUpdatedAt: 0,
    ...overrides,
  };
}

describe("applyFetchLogOverlay", () => {
  it("rewrites update sessions whose fetch_log row succeeded", async () => {
    const db = mkDb();
    db.insert(fetchLog)
      .values({
        sourceId: "src_a1",
        sessionId: "ma-1",
        releasesFound: 29,
        releasesInserted: 29,
        status: "success",
      })
      .run();

    const [session] = await applyFetchLogOverlay(db, [mkSession()]);
    expect(session.status).toBe("complete");
    expect(session.warnings?.[0]).toContain("fetch_log shows the fetch succeeded");
    expect(session.warnings?.[0]).toContain("Network connection lost");
  });

  it("leaves the session alone when any fetch_log row reports an error", async () => {
    const db = mkDb();
    db.insert(fetchLog)
      .values([
        {
          sourceId: "src_a1",
          sessionId: "ma-1",
          releasesFound: 5,
          releasesInserted: 5,
          status: "success",
        },
        {
          sourceId: "src_a1",
          sessionId: "ma-1",
          releasesFound: 0,
          releasesInserted: 0,
          status: "error",
          error: "boom",
        },
      ])
      .run();

    const [session] = await applyFetchLogOverlay(db, [mkSession()]);
    expect(session.status).toBe("error");
    expect(session.warnings).toBeUndefined();
  });

  it("leaves the session alone when no fetch_log rows exist", async () => {
    const db = mkDb();
    const [session] = await applyFetchLogOverlay(db, [mkSession()]);
    expect(session.status).toBe("error");
    expect(session.warnings).toBeUndefined();
  });

  it("skips provider-attributed errors (real upstream failures)", async () => {
    const db = mkDb();
    db.insert(fetchLog)
      .values({
        sourceId: "src_a1",
        sessionId: "ma-1",
        releasesFound: 0,
        releasesInserted: 0,
        status: "success",
      })
      .run();

    const [session] = await applyFetchLogOverlay(db, [
      mkSession({ errorSource: "provider", errorType: "model_overloaded" }),
    ]);
    expect(session.status).toBe("error");
  });

  it("skips onboard sessions even when fetch_log rows succeeded", async () => {
    const db = mkDb();
    db.insert(fetchLog)
      .values({
        sourceId: "src_a1",
        sessionId: "ma-1",
        releasesFound: 1,
        releasesInserted: 1,
        status: "success",
      })
      .run();

    const [session] = await applyFetchLogOverlay(db, [mkSession({ type: "onboard" })]);
    expect(session.status).toBe("error");
  });

  it("does not touch sessions that aren't in 'error'", async () => {
    const db = mkDb();
    db.insert(fetchLog)
      .values({
        sourceId: "src_a1",
        sessionId: "ma-1",
        releasesFound: 1,
        releasesInserted: 1,
        status: "success",
      })
      .run();

    const [session] = await applyFetchLogOverlay(db, [mkSession({ status: "running" })]);
    expect(session.status).toBe("running");
  });

  it("processes a mixed batch in a single query", async () => {
    const db = mkDb();
    db.insert(fetchLog)
      .values([
        {
          sourceId: "src_a1",
          sessionId: "ma-good",
          releasesFound: 3,
          releasesInserted: 3,
          status: "success",
        },
        {
          sourceId: "src_a1",
          sessionId: "ma-bad",
          releasesFound: 0,
          releasesInserted: 0,
          status: "error",
          error: "boom",
        },
      ])
      .run();

    const sessions = await applyFetchLogOverlay(db, [
      mkSession({ sessionId: "ma-good" }),
      mkSession({ sessionId: "ma-bad" }),
      mkSession({ sessionId: "ma-orphan" }),
    ]);
    expect(sessions[0].status).toBe("complete");
    expect(sessions[1].status).toBe("error");
    expect(sessions[2].status).toBe("error");
  });

  it("treats missing errorSource as 'us' (legacy sessions)", async () => {
    const db = mkDb();
    db.insert(fetchLog)
      .values({
        sourceId: "src_a1",
        sessionId: "ma-1",
        releasesFound: 2,
        releasesInserted: 2,
        status: "success",
      })
      .run();

    const session = mkSession();
    delete (session as { errorSource?: string }).errorSource;
    const [out] = await applyFetchLogOverlay(db, [session]);
    expect(out.status).toBe("complete");
  });
});

describe("applyFetchLogOverlaySingle", () => {
  it("returns the same object with overlay applied", async () => {
    const db = mkDb();
    db.insert(fetchLog)
      .values({
        sourceId: "src_a1",
        sessionId: "ma-1",
        releasesFound: 1,
        releasesInserted: 1,
        status: "success",
      })
      .run();

    const input = mkSession();
    const output = await applyFetchLogOverlaySingle(db, input);
    expect(output).toBe(input);
    expect(output.status).toBe("complete");
  });
});
