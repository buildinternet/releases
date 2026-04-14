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
        headers: { ETag: '"test-etag-1"' },
      },
      "/atom.xml": {
        body: readFeedFixture("atom-basic.xml"),
        contentType: "application/atom+xml",
      },
      "/feed.json": {
        body: readFeedFixture("jsonfeed-basic.json"),
        contentType: "application/feed+json",
      },
    },
  });
});

afterAll(() => server.stop());

describe("fetch CLI pipeline (fixture server)", () => {
  describe("feed-type source fetch", () => {
    let dataDir: string;
    let cleanup: () => void;

    beforeAll(() => {
      ({ dataDir, cleanup } = createTempDataDir());
      cli(dataDir, ["admin", "org", "add", "Test Org", "--category", "cloud"]);
      cli(dataDir, [
        "admin", "source", "add", "Test Feed",
        "--url", `${server.url}/feed.xml`,
        "--feed-url", `${server.url}/feed.xml`,
        "--org", "test-org",
        "--type", "feed",
        "--skip-eval",
      ]);
    });

    afterAll(() => cleanup());

    it("fetches releases from feed source", () => {
      const result = cli(dataDir, ["admin", "source", "fetch", "test-feed", "--no-summarize"], { timeout: 20_000 });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("Parsed 2 releases");
    }, 25_000);

    it("releases appear in latest output", () => {
      const result = cli(dataDir, ["latest", "test-feed", "--json"]);
      expect(result.exitCode).toBe(0);
      const releases = JSON.parse(result.stdout);
      expect(releases.length).toBe(2);
      expect(releases[0].title).toContain("Dashboard Redesign");
    });

    it("second fetch detects no change (ETag caching)", () => {
      const result = cli(dataDir, ["admin", "source", "fetch", "test-feed", "--no-summarize"], { timeout: 20_000 });
      expect(result.exitCode).toBe(0);
      expect(result.stderr + result.stdout).toMatch(/no (new )?releases|no changes|0 new/i);
    }, 25_000);
  });

  describe("fetch with --max flag", () => {
    let dataDir: string;
    let cleanup: () => void;

    beforeAll(() => {
      ({ dataDir, cleanup } = createTempDataDir());
      cli(dataDir, ["admin", "org", "add", "Max Test Org", "--category", "cloud"]);
      cli(dataDir, [
        "admin", "source", "add", "Max Test Feed",
        "--url", `${server.url}/atom.xml`,
        "--feed-url", `${server.url}/atom.xml`,
        "--org", "max-test-org",
        "--type", "feed",
        "--skip-eval",
      ]);
    });

    afterAll(() => cleanup());

    it("respects --max 1 limit", () => {
      const result = cli(dataDir, ["admin", "source", "fetch", "max-test-feed", "--max", "1", "--no-summarize"], { timeout: 20_000 });
      expect(result.exitCode).toBe(0);
      const latest = cliJson<unknown[]>(dataDir, ["latest", "max-test-feed", "--json"]);
      expect(latest.length).toBe(1);
    }, 25_000);
  });

  describe("fetch with --dry-run", () => {
    let dataDir: string;
    let cleanup: () => void;

    beforeAll(() => {
      ({ dataDir, cleanup } = createTempDataDir());
      cli(dataDir, ["admin", "org", "add", "Dry Run Org", "--category", "cloud"]);
      cli(dataDir, [
        "admin", "source", "add", "Dry Run Feed",
        "--url", `${server.url}/feed.json`,
        "--feed-url", `${server.url}/feed.json`,
        "--org", "dry-run-org",
        "--type", "feed",
        "--skip-eval",
      ]);
    });

    afterAll(() => cleanup());

    it("does not persist releases on --dry-run", () => {
      const result = cli(dataDir, ["admin", "source", "fetch", "dry-run-feed", "--dry-run", "--no-summarize"], { timeout: 20_000 });
      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toMatch(/2 release/);
      const latest = cli(dataDir, ["latest", "dry-run-feed", "--json"]);
      const releases = JSON.parse(latest.stdout);
      expect(releases.length).toBe(0);
    }, 25_000);
  });

  describe("fetch --json output", () => {
    let dataDir: string;
    let cleanup: () => void;

    beforeAll(() => {
      ({ dataDir, cleanup } = createTempDataDir());
      cli(dataDir, ["admin", "org", "add", "JSON Org", "--category", "cloud"]);
      cli(dataDir, [
        "admin", "source", "add", "JSON Feed",
        "--url", `${server.url}/feed.xml`,
        "--feed-url", `${server.url}/feed.xml`,
        "--org", "json-org",
        "--type", "feed",
        "--skip-eval",
      ]);
    });

    afterAll(() => cleanup());

    it("returns structured JSON result", () => {
      const result = cli(dataDir, ["admin", "source", "fetch", "json-feed", "--json", "--no-summarize"], { timeout: 20_000 });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0].source).toBe("JSON Feed");
      expect(parsed[0].newReleases).toBe(2);
    }, 25_000);
  });
});
