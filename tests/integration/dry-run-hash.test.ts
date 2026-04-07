import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createTempDataDir, cli, cliJson } from "../cli/roundtrip-helper.js";
import { startSubprocessFixtureServer, readFeedFixture, type SubprocessFixtureServer } from "../fixtures/server.js";

let server: SubprocessFixtureServer;

beforeAll(() => {
  server = startSubprocessFixtureServer({
    routes: {
      "/feed.xml": {
        body: readFeedFixture("rss-basic.xml"),
        contentType: "application/rss+xml",
        headers: { ETag: '"dry-run-test-etag"' },
      },
    },
  });
});

afterAll(() => server.stop());

describe("dry-run does not poison subsequent fetches", () => {
  let dataDir: string;
  let cleanup: () => void;

  beforeAll(() => {
    ({ dataDir, cleanup } = createTempDataDir());
    cli(dataDir, ["org", "add", "DryHash Org", "--category", "cloud"]);
    cli(dataDir, [
      "add", "DryHash Feed",
      "--url", `${server.url}/feed.xml`,
      "--feed-url", `${server.url}/feed.xml`,
      "--org", "dryhash-org",
      "--type", "feed",
      "--skip-eval",
    ]);
  });

  afterAll(() => cleanup());

  it("dry-run fetch followed by real fetch still finds releases", () => {
    // First: dry-run fetch — should find releases but not persist them
    const dryResult = cli(dataDir, ["fetch", "dryhash-feed", "--dry-run", "--no-summarize"], { timeout: 20_000 });
    expect(dryResult.exitCode).toBe(0);
    expect(dryResult.stdout + dryResult.stderr).toMatch(/2 release/);

    // Verify no releases were persisted
    const afterDry = cliJson<unknown[]>(dataDir, ["latest", "dryhash-feed", "--json"]);
    expect(afterDry.length).toBe(0);

    // Second: real fetch — should still find releases (not blocked by cached hash/ETag)
    const realResult = cli(dataDir, ["fetch", "dryhash-feed", "--no-summarize"], { timeout: 20_000 });
    expect(realResult.exitCode).toBe(0);
    expect(realResult.stderr).toContain("Parsed 2 releases");

    // Verify releases were persisted
    const afterReal = cliJson<unknown[]>(dataDir, ["latest", "dryhash-feed", "--json"]);
    expect(afterReal.length).toBe(2);
  }, 30_000);
});
