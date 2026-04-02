import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { startFixtureServer, readFeedFixture, type FixtureServer } from "../fixtures/server.js";
import { fetchAndParseFeed } from "../../src/adapters/feed.js";

let server: FixtureServer;

beforeAll(() => {
  server = startFixtureServer({
    routes: {
      "/feed.xml": {
        body: readFeedFixture("rss-basic.xml"),
        contentType: "application/rss+xml",
        headers: { ETag: '"abc123"' },
      },
      "/atom.xml": {
        body: readFeedFixture("atom-basic.xml"),
        contentType: "application/atom+xml",
      },
      "/feed.json": {
        body: readFeedFixture("jsonfeed-basic.json"),
        contentType: "application/feed+json",
      },
      "/empty.xml": {
        body: `<?xml version="1.0"?><rss version="2.0"><channel><title>Empty</title></channel></rss>`,
        contentType: "application/rss+xml",
      },
      "/error": {
        body: "Internal Server Error",
        contentType: "text/plain",
        status: 500,
      },
      "/304.xml": {
        body: "",
        contentType: "application/rss+xml",
        status: 304,
      },
    },
  });
});

afterAll(() => server.stop());

describe("fetchAndParseFeed (HTTP integration)", () => {
  it("fetches and parses RSS feed from HTTP server", async () => {
    const result = await fetchAndParseFeed(`${server.url}/feed.xml`, "rss");
    expect(result.releases).toHaveLength(2);
    expect(result.releases[0].title).toBe("v2.1.0 — Dashboard Redesign");
    expect(result.releases[0].version).toBe("2.1.0");
    expect(result.releases[0].url).toBe("https://acme.com/changelog/v2-1-0");
    expect(result.etag).toBe('"abc123"');
  });

  it("fetches and parses Atom feed from HTTP server", async () => {
    const result = await fetchAndParseFeed(`${server.url}/atom.xml`, "atom");
    expect(result.releases).toHaveLength(2);
    expect(result.releases[0].title).toBe("v3.0.0 — Breaking: New Auth System");
    expect(result.releases[0].version).toBe("3.0.0");
  });

  it("fetches and parses JSON Feed from HTTP server", async () => {
    const result = await fetchAndParseFeed(`${server.url}/feed.json`, "jsonfeed");
    expect(result.releases).toHaveLength(2);
    expect(result.releases[0].title).toBe("v1.5.0 — New CLI Tool");
    expect(result.releases[0].version).toBe("1.5.0");
  });

  it("returns empty releases for empty feed", async () => {
    const result = await fetchAndParseFeed(`${server.url}/empty.xml`, "rss");
    expect(result.releases).toHaveLength(0);
  });

  it("returns empty releases on 304 Not Modified", async () => {
    const result = await fetchAndParseFeed(`${server.url}/304.xml`, "rss");
    expect(result.releases).toHaveLength(0);
  });

  it("throws on server error", async () => {
    await expect(
      fetchAndParseFeed(`${server.url}/error`, "rss"),
    ).rejects.toThrow("Feed fetch failed: 500");
  });

  it("respects since filter", async () => {
    const result = await fetchAndParseFeed(`${server.url}/feed.xml`, "rss", {
      since: new Date("2024-01-10T00:00:00Z"),
    });
    expect(result.releases).toHaveLength(1);
    expect(result.releases[0].version).toBe("2.1.0");
  });

  it("respects maxEntries filter", async () => {
    const result = await fetchAndParseFeed(`${server.url}/feed.xml`, "rss", {
      maxEntries: 1,
    });
    expect(result.releases).toHaveLength(1);
    expect(result.releases[0].version).toBe("2.1.0");
  });
});
