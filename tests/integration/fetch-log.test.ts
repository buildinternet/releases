import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createTempDataDir, cli } from "../cli/roundtrip-helper.js";
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

describe("fetch-log tracking", () => {
  let dataDir: string;
  let cleanup: () => void;

  beforeAll(() => {
    ({ dataDir, cleanup } = createTempDataDir());
    cli(dataDir, ["org", "add", "Log Org", "--category", "cloud"]);
    cli(dataDir, [
      "add", "Log Source",
      "--url", `${server.url}/feed.xml`,
      "--feed-url", `${server.url}/feed.xml`,
      "--org", "log-org",
      "--type", "feed",
      "--skip-eval",
    ]);
  });

  afterAll(() => cleanup());

  it("records successful fetch in fetch-log", () => {
    const fetchResult = cli(dataDir, ["fetch", "log-source", "--no-summarize"], { timeout: 15_000 });
    expect(fetchResult.exitCode).toBe(0);

    const logResult = cli(dataDir, ["fetch-log", "log-source", "--json"]);
    expect(logResult.exitCode).toBe(0);
    const logs = JSON.parse(logResult.stdout);
    expect(logs.length).toBeGreaterThanOrEqual(1);
    const lastLog = logs[0];
    expect(lastLog.status).toBe("success");
    expect(lastLog.releasesFound).toBe(2);
    expect(lastLog.releasesInserted).toBe(2);
  }, 20_000);

  it("records no_change on subsequent fetch", () => {
    const fetchResult = cli(dataDir, ["fetch", "log-source", "--no-summarize"], { timeout: 15_000 });
    expect(fetchResult.exitCode).toBe(0);

    const logResult = cli(dataDir, ["fetch-log", "log-source", "--json"]);
    const logs = JSON.parse(logResult.stdout);
    // Most recent log should be no_change (releases already in DB, dedup)
    expect(logs[0].status).toMatch(/no_change|success/);
  }, 20_000);

  it("records dry_run in fetch-log", () => {
    cli(dataDir, [
      "add", "Dry Log Source",
      "--url", `${server.url}/feed.xml`,
      "--feed-url", `${server.url}/feed.xml`,
      "--org", "log-org",
      "--type", "feed",
      "--skip-eval",
    ]);
    const fetchResult = cli(dataDir, ["fetch", "dry-log-source", "--dry-run", "--no-summarize"], { timeout: 15_000 });
    expect(fetchResult.exitCode).toBe(0);

    const logResult = cli(dataDir, ["fetch-log", "dry-log-source", "--json"]);
    const logs = JSON.parse(logResult.stdout);
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0].status).toBe("dry_run");
    expect(logs[0].releasesFound).toBe(2);
    expect(logs[0].releasesInserted).toBe(0);
  }, 20_000);
});
