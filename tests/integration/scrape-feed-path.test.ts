import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createTempDataDir, cli, cliJson, cliAsync } from "../cli/roundtrip-helper.js";
import { startFixtureServer, readFeedFixture, type FixtureServer } from "../fixtures/server.js";

let server: FixtureServer;

beforeAll(() => {
  server = startFixtureServer({
    routes: {
      "/changelog": {
        body: `<!DOCTYPE html>
<html><head>
  <title>Changelog</title>
  <link rel="alternate" type="application/rss+xml" href="/changelog/feed.xml" />
</head><body>
  <h1>Changelog</h1>
  <p>See our latest updates.</p>
</body></html>`,
        contentType: "text/html",
      },
      "/changelog/feed.xml": {
        body: readFeedFixture("rss-basic.xml"),
        contentType: "application/rss+xml",
      },
      "/no-feed": {
        body: `<!DOCTYPE html>
<html><head><title>No Feed</title></head>
<body><h1>Updates</h1></body></html>`,
        contentType: "text/html",
      },
    },
  });
});

afterAll(() => server.stop());

describe("scrape adapter feed-first path", () => {
  describe("source with discoverable feed", () => {
    let dataDir: string;
    let cleanup: () => void;

    beforeAll(() => {
      ({ dataDir, cleanup } = createTempDataDir());
      cli(dataDir, ["admin", "org", "add", "Feed Discovery Org", "--category", "cloud"]);
      cli(dataDir, [
        "admin",
        "source",
        "add",
        "Feed Discovery Source",
        "--url",
        `${server.url}/changelog`,
        "--org",
        "feed-discovery-org",
        "--skip-eval",
      ]);
    });

    afterAll(() => cleanup());

    it("discovers feed and fetches releases via feed path (no AI needed)", async () => {
      const result = await cliAsync(
        dataDir,
        ["admin", "source", "fetch", "feed-discovery-source", "--no-summarize"],
        { timeout: 15_000 },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("feed");
      const latest = cliJson<unknown[]>(dataDir, ["latest", "feed-discovery-source", "--json"]);
      expect(latest.length).toBe(2);
    }, 20_000);

    it("stores feed URL in source metadata after discovery", () => {
      const source = cliJson<{ metadata?: string | Record<string, unknown> }>(dataDir, [
        "list",
        "feed-discovery-source",
        "--json",
      ]);
      const meta =
        typeof source.metadata === "string" ? JSON.parse(source.metadata) : (source.metadata ?? {});
      expect(meta.feedUrl).toContain("/changelog/feed.xml");
      expect(meta.feedType).toBe("rss");
    }, 10_000);
  });

  describe("source with no feed (noFeedFound)", () => {
    let dataDir: string;
    let cleanup: () => void;

    beforeAll(() => {
      ({ dataDir, cleanup } = createTempDataDir());
      cli(dataDir, ["admin", "org", "add", "No Feed Org", "--category", "cloud"]);
      cli(dataDir, [
        "admin",
        "source",
        "add",
        "No Feed Source",
        "--url",
        `${server.url}/no-feed`,
        "--org",
        "no-feed-org",
        "--skip-eval",
      ]);
    });

    afterAll(() => cleanup());

    it("marks noFeedFound after failed discovery", async () => {
      await cliAsync(dataDir, ["admin", "source", "fetch", "no-feed-source", "--no-summarize"], {
        timeout: 15_000,
      });
      const source = cliJson<{ metadata?: string | Record<string, unknown> }>(dataDir, [
        "list",
        "no-feed-source",
        "--json",
      ]);
      const meta =
        typeof source.metadata === "string" ? JSON.parse(source.metadata) : (source.metadata ?? {});
      expect(meta.noFeedFound).toBe(true);
    }, 20_000);
  });

  describe("source with pre-configured feed URL in metadata", () => {
    let dataDir: string;
    let cleanup: () => void;

    beforeAll(() => {
      ({ dataDir, cleanup } = createTempDataDir());
      cli(dataDir, ["admin", "org", "add", "Preconfig Org", "--category", "cloud"]);
      cli(dataDir, [
        "admin",
        "source",
        "add",
        "Preconfig Source",
        "--url",
        `${server.url}/changelog`,
        "--org",
        "preconfig-org",
        "--type",
        "feed",
        "--skip-eval",
      ]);
    });

    afterAll(() => cleanup());

    it("uses feed type source to fetch directly", async () => {
      const result = await cliAsync(
        dataDir,
        ["admin", "source", "fetch", "preconfig-source", "--no-summarize"],
        { timeout: 15_000 },
      );
      expect(result.exitCode).toBe(0);
      const latest = cliJson<unknown[]>(dataDir, ["latest", "preconfig-source", "--json"]);
      expect(latest.length).toBeGreaterThan(0);
    }, 20_000);
  });
});
