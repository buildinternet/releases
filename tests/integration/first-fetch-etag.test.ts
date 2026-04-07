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
        headers: { ETag: '"pre-stored-etag"' },
      },
    },
  });
});

afterAll(() => server.stop());

describe("first fetch ignores pre-stored ETags", () => {
  let dataDir: string;
  let cleanup: () => void;

  beforeAll(() => {
    ({ dataDir, cleanup } = createTempDataDir());
    cli(dataDir, ["org", "add", "ETag Test Org", "--category", "cloud"]);
    cli(dataDir, [
      "add", "ETag Test Feed",
      "--url", `${server.url}/feed.xml`,
      "--feed-url", `${server.url}/feed.xml`,
      "--org", "etag-test-org",
      "--type", "feed",
      "--skip-eval",
    ]);
  });

  afterAll(() => cleanup());

  it("fetches releases even when poll has pre-stored an ETag", () => {
    // Simulate poll storing an ETag before first real fetch by running poll first.
    // Poll runs HEAD checks which store ETags in metadata.
    const pollResult = cli(dataDir, ["poll", "etag-test-feed"], { timeout: 20_000 });
    expect(pollResult.exitCode).toBe(0);

    // Verify the source still has no releases (poll doesn't fetch)
    const beforeFetch = cliJson<unknown[]>(dataDir, ["latest", "etag-test-feed", "--json"]);
    expect(beforeFetch.length).toBe(0);

    // Now fetch — should succeed despite stored ETag because lastFetchedAt is null
    const fetchResult = cli(dataDir, ["fetch", "etag-test-feed", "--no-summarize"], { timeout: 20_000 });
    expect(fetchResult.exitCode).toBe(0);
    expect(fetchResult.stderr).toContain("Parsed 2 releases");

    // Verify releases were persisted
    const afterFetch = cliJson<unknown[]>(dataDir, ["latest", "etag-test-feed", "--json"]);
    expect(afterFetch.length).toBe(2);
  }, 30_000);

  it("second fetch correctly uses ETag caching", () => {
    // Second fetch should use the ETag and detect no changes
    const result = cli(dataDir, ["fetch", "etag-test-feed", "--no-summarize"], { timeout: 20_000 });
    expect(result.exitCode).toBe(0);
    expect(result.stderr + result.stdout).toMatch(/no (new )?releases|no changes|0 new|unchanged/i);
  }, 25_000);
});
