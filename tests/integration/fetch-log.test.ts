import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { desc, eq } from "drizzle-orm";
import { join } from "path";
import { createTempDataDir, cli } from "../cli/roundtrip-helper.js";
import { fetchLog, sources } from "@releases/core-internal/schema";
import {
  startSubprocessFixtureServer,
  readFeedFixture,
  type SubprocessFixtureServer,
} from "../fixtures/server.js";

let server: SubprocessFixtureServer;

beforeAll(() => {
  server = startSubprocessFixtureServer({
    routes: {
      "/feed.xml": {
        body: readFeedFixture("rss-basic.xml"),
        contentType: "application/rss+xml",
      },
    },
  });
});

afterAll(() => server.stop());

function readFetchLogs(dataDir: string, slug: string) {
  const sqlite = new Database(join(dataDir, "releases.db"), { readonly: true });
  try {
    const db = drizzle(sqlite);
    return db.select()
      .from(fetchLog)
      .innerJoin(sources, eq(fetchLog.sourceId, sources.id))
      .where(eq(sources.slug, slug))
      .orderBy(desc(fetchLog.createdAt))
      .all()
      .map((row) => row.fetch_log);
  } finally {
    sqlite.close();
  }
}

describe("fetch-log tracking", () => {
  let dataDir: string;
  let cleanup: () => void;

  beforeAll(() => {
    ({ dataDir, cleanup } = createTempDataDir());
    cli(dataDir, ["admin", "org", "add", "Log Org", "--category", "cloud"]);
    cli(dataDir, [
      "admin", "source", "add", "Log Source",
      "--url", `${server.url}/feed.xml`,
      "--feed-url", `${server.url}/feed.xml`,
      "--org", "log-org",
      "--type", "feed",
      "--skip-eval",
    ]);
  });

  afterAll(() => cleanup());

  it("records successful fetch in fetch-log", () => {
    const fetchResult = cli(dataDir, ["admin", "source", "fetch", "log-source", "--no-summarize"], { timeout: 15_000 });
    expect(fetchResult.exitCode).toBe(0);

    const logs = readFetchLogs(dataDir, "log-source");
    expect(logs.length).toBeGreaterThanOrEqual(1);
    const lastLog = logs[0];
    expect(lastLog.status).toBe("success");
    expect(lastLog.releasesFound).toBe(2);
    expect(lastLog.releasesInserted).toBe(2);
  }, 20_000);

  it("records no_change on subsequent fetch", () => {
    const fetchResult = cli(dataDir, ["admin", "source", "fetch", "log-source", "--no-summarize"], { timeout: 15_000 });
    expect(fetchResult.exitCode).toBe(0);

    const logs = readFetchLogs(dataDir, "log-source");
    expect(logs[0].status).toMatch(/no_change|success/);
  }, 20_000);

  it("records dry_run in fetch-log", () => {
    cli(dataDir, [
      "admin", "source", "add", "Dry Log Source",
      "--url", `${server.url}/feed.xml`,
      "--feed-url", `${server.url}/feed.xml`,
      "--org", "log-org",
      "--type", "feed",
      "--skip-eval",
    ]);
    const fetchResult = cli(dataDir, ["admin", "source", "fetch", "dry-log-source", "--dry-run", "--no-summarize"], { timeout: 15_000 });
    expect(fetchResult.exitCode).toBe(0);

    const logs = readFetchLogs(dataDir, "dry-log-source");
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0].status).toBe("dry_run");
    expect(logs[0].releasesFound).toBe(2);
    expect(logs[0].releasesInserted).toBe(0);
  }, 20_000);
});
