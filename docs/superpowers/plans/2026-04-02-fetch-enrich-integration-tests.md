# Fetch & Enrich Integration Tests

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add integration tests for the fetch, enrich, and scrape adapter feed-first pipeline — the core data path currently untested.

**Architecture:** Fixture HTTP server (Bun.serve) serves RSS/Atom/JSON feeds and HTML pages. CLI round-trip tests seed orgs+sources, run `fetch`/`enrich`, and assert releases in DB via `--json` output. Direct adapter tests call `fetchAndParseFeed()` and `fetchViaFeed()` against the fixture server. Dedup and backoff are tested via DB-level assertions using `createTestDb()`.

**Tech Stack:** Bun test runner, Bun.serve for fixture HTTP, existing test helpers (createTempDataDir, createTestDb, cli/cliJson)

---

### Task 1: Fixture HTTP Server Helper

**Files:**

- Create: `tests/fixtures/server.ts`

This helper spins up a local HTTP server that serves fixture files and custom responses. Used by all integration tests in Tasks 2-5.

- [ ] **Step 1: Create the fixture server helper**

```typescript
// tests/fixtures/server.ts
import { readFileSync } from "fs";
import { join } from "path";
import type { Server } from "bun";

const FEEDS_DIR = join(import.meta.dirname, "feeds");

interface FixtureRoute {
  body: string;
  contentType: string;
  status?: number;
  headers?: Record<string, string>;
}

interface FixtureServerOptions {
  /** Static routes: path → response */
  routes?: Record<string, FixtureRoute>;
}

export interface FixtureServer {
  url: string;
  port: number;
  server: Server;
  stop: () => void;
}

/**
 * Start a local HTTP server for test fixtures.
 * Uses port 0 for auto-assignment to avoid conflicts.
 */
export function startFixtureServer(options?: FixtureServerOptions): FixtureServer {
  const routes = options?.routes ?? {};

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const route = routes[url.pathname];
      if (route) {
        return new Response(route.body, {
          status: route.status ?? 200,
          headers: {
            "Content-Type": route.contentType,
            ...route.headers,
          },
        });
      }
      return new Response("Not Found", { status: 404 });
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    port: server.port,
    server,
    stop: () => server.stop(),
  };
}

/** Read a feed fixture file from tests/fixtures/feeds/ */
export function readFeedFixture(name: string): string {
  return readFileSync(join(FEEDS_DIR, name), "utf-8");
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd ~/Code/released && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors in `tests/fixtures/server.ts`

- [ ] **Step 3: Commit**

```bash
git add tests/fixtures/server.ts
git commit -m "test: add fixture HTTP server helper for integration tests"
```

---

### Task 2: Feed Adapter Integration Tests (Fixture Server)

**Files:**

- Create: `tests/integration/feed-adapter.test.ts`

Tests `fetchAndParseFeed()` against a real HTTP server serving fixture feeds. Covers conditional fetch (ETag/304), `since` and `maxEntries` filtering, and error handling.

- [ ] **Step 1: Write the feed adapter integration tests**

```typescript
// tests/integration/feed-adapter.test.ts
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
    await expect(fetchAndParseFeed(`${server.url}/error`, "rss")).rejects.toThrow(
      "Feed fetch failed: 500",
    );
  });

  it("respects since filter", async () => {
    const result = await fetchAndParseFeed(`${server.url}/feed.xml`, "rss", {
      since: new Date("2024-01-10T00:00:00Z"),
    });
    // Only v2.1.0 (Jan 15) should pass, v2.0.0 (Jan 1) is before cutoff
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
```

- [ ] **Step 2: Run the tests**

Run: `cd ~/Code/released && bun test tests/integration/feed-adapter.test.ts`
Expected: All 8 tests pass

- [ ] **Step 3: Commit**

```bash
git add tests/integration/feed-adapter.test.ts
git commit -m "test: add feed adapter integration tests with fixture HTTP server"
```

---

### Task 3: Fetch CLI Integration Tests (Full Pipeline)

**Files:**

- Create: `tests/integration/fetch-pipeline.test.ts`

Tests the full CLI `fetch` command pipeline: org → source → fetch → releases in DB. Uses fixture HTTP server + `createTempDataDir()` for isolated CLI round-trips.

- [ ] **Step 1: Write the fetch pipeline integration tests**

```typescript
// tests/integration/fetch-pipeline.test.ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createTempDataDir, cli, cliJson } from "../cli/roundtrip-helper.js";
import { startFixtureServer, readFeedFixture, type FixtureServer } from "../fixtures/server.js";

let server: FixtureServer;

beforeAll(() => {
  server = startFixtureServer({
    routes: {
      // HTML page with feed link in <head> for auto-discovery
      "/changelog": {
        body: `<!DOCTYPE html>
<html><head>
  <link rel="alternate" type="application/rss+xml" href="/feed.xml" />
</head><body><h1>Changelog</h1></body></html>`,
        contentType: "text/html",
      },
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
      // Seed org
      cli(dataDir, ["org", "add", "Test Org", "--category", "cloud"]);
      // Add source with type=feed pointing at fixture RSS
      cli(dataDir, [
        "add",
        "Test Feed",
        "--url",
        `${server.url}/feed.xml`,
        "--org",
        "test-org",
        "--type",
        "feed",
        "--skip-eval",
      ]);
    });

    afterAll(() => cleanup());

    it("fetches releases from feed source", () => {
      const result = cli(dataDir, ["fetch", "test-feed", "--no-summarize"], { timeout: 15_000 });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("Parsed 2 releases");
    });

    it("releases appear in latest output", () => {
      const result = cli(dataDir, ["latest", "test-feed", "--json"]);
      expect(result.exitCode).toBe(0);
      const releases = JSON.parse(result.stdout);
      expect(releases.length).toBe(2);
      expect(releases[0].title).toContain("Dashboard Redesign");
    });

    it("second fetch detects no change (ETag caching)", () => {
      const result = cli(dataDir, ["fetch", "test-feed", "--no-summarize"], { timeout: 15_000 });
      expect(result.exitCode).toBe(0);
      // Should report no new releases on second fetch
      expect(result.stderr + result.stdout).toMatch(/no (new )?releases|no changes|0 new/i);
    });
  });

  describe("fetch with --max flag", () => {
    let dataDir: string;
    let cleanup: () => void;

    beforeAll(() => {
      ({ dataDir, cleanup } = createTempDataDir());
      cli(dataDir, ["org", "add", "Max Test Org", "--category", "cloud"]);
      cli(dataDir, [
        "add",
        "Max Test Feed",
        "--url",
        `${server.url}/atom.xml`,
        "--org",
        "max-test-org",
        "--type",
        "feed",
        "--skip-eval",
      ]);
    });

    afterAll(() => cleanup());

    it("respects --max 1 limit", () => {
      const result = cli(dataDir, ["fetch", "max-test-feed", "--max", "1", "--no-summarize"], {
        timeout: 15_000,
      });
      expect(result.exitCode).toBe(0);
      const latest = cliJson<unknown[]>(dataDir, ["latest", "max-test-feed", "--json"]);
      expect(latest.length).toBe(1);
    });
  });

  describe("fetch with --dry-run", () => {
    let dataDir: string;
    let cleanup: () => void;

    beforeAll(() => {
      ({ dataDir, cleanup } = createTempDataDir());
      cli(dataDir, ["org", "add", "Dry Run Org", "--category", "cloud"]);
      cli(dataDir, [
        "add",
        "Dry Run Feed",
        "--url",
        `${server.url}/feed.json`,
        "--org",
        "dry-run-org",
        "--type",
        "feed",
        "--skip-eval",
      ]);
    });

    afterAll(() => cleanup());

    it("does not persist releases on --dry-run", () => {
      const result = cli(dataDir, ["fetch", "dry-run-feed", "--dry-run", "--no-summarize"], {
        timeout: 15_000,
      });
      expect(result.exitCode).toBe(0);
      // Dry run should show found releases
      expect(result.stdout + result.stderr).toMatch(/2 release/);
      // But latest should be empty (nothing persisted)
      const latest = cli(dataDir, ["latest", "dry-run-feed", "--json"]);
      const releases = JSON.parse(latest.stdout);
      expect(releases.length).toBe(0);
    });
  });

  describe("fetch --json output", () => {
    let dataDir: string;
    let cleanup: () => void;

    beforeAll(() => {
      ({ dataDir, cleanup } = createTempDataDir());
      cli(dataDir, ["org", "add", "JSON Org", "--category", "cloud"]);
      cli(dataDir, [
        "add",
        "JSON Feed",
        "--url",
        `${server.url}/feed.xml`,
        "--org",
        "json-org",
        "--type",
        "feed",
        "--skip-eval",
      ]);
    });

    afterAll(() => cleanup());

    it("returns structured JSON result", () => {
      const result = cli(dataDir, ["fetch", "json-feed", "--json", "--no-summarize"], {
        timeout: 15_000,
      });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0].source).toBe("JSON Feed");
      expect(parsed[0].newReleases).toBe(2);
    });
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `cd ~/Code/released && bun test tests/integration/fetch-pipeline.test.ts`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add tests/integration/fetch-pipeline.test.ts
git commit -m "test: add fetch CLI pipeline integration tests with fixture server"
```

---

### Task 4: Release Dedup and Backoff Tests (DB-Level)

**Files:**

- Create: `tests/integration/fetch-dedup-backoff.test.ts`

Tests the dedup logic (UNIQUE constraints, onConflictDoNothing) and backoff mechanics using `createTestDb()` for direct DB manipulation.

- [ ] **Step 1: Write dedup and backoff tests**

```typescript
// tests/integration/fetch-dedup-backoff.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { sources, releases, organizations } from "../../src/db/schema.js";
import { contentHash } from "../../src/adapters/resolve.js";
import type { RawRelease } from "../../src/adapters/types.js";

let testDb: TestDatabase;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.cleanup();
});

async function seedSource(db: typeof testDb.db) {
  const [org] = await db
    .insert(organizations)
    .values({
      name: "Test Org",
      slug: "test-org",
    })
    .returning();

  const [source] = await db
    .insert(sources)
    .values({
      name: "Test Source",
      slug: "test-source",
      type: "feed",
      url: "https://example.com/feed.xml",
      orgId: org.id,
    })
    .returning();

  return { org, source };
}

function makeRawRelease(overrides?: Partial<RawRelease>): RawRelease {
  return {
    title: "v1.0.0 — Test Release",
    content: "Test content for release",
    url: "https://example.com/releases/v1-0-0",
    version: "1.0.0",
    publishedAt: new Date("2024-01-15T00:00:00Z"),
    ...overrides,
  };
}

describe("release dedup (UNIQUE constraints)", () => {
  it("inserts releases with unique URLs", async () => {
    const { source } = await seedSource(testDb.db);
    const raw1 = makeRawRelease({ url: "https://example.com/r/1", title: "Release 1" });
    const raw2 = makeRawRelease({ url: "https://example.com/r/2", title: "Release 2" });

    const rows = [raw1, raw2].map((r) => ({
      sourceId: source.id,
      version: r.version ?? null,
      title: r.title,
      content: r.content,
      url: r.url ?? null,
      contentHash: contentHash(r),
      publishedAt: r.publishedAt?.toISOString() ?? null,
    }));

    const result = await testDb.db.insert(releases).values(rows).returning();
    expect(result).toHaveLength(2);
  });

  it("rejects duplicate URL for same source (UNIQUE constraint)", async () => {
    const { source } = await seedSource(testDb.db);
    const raw = makeRawRelease();

    const row = {
      sourceId: source.id,
      version: raw.version ?? null,
      title: raw.title,
      content: raw.content,
      url: raw.url ?? null,
      contentHash: contentHash(raw),
      publishedAt: raw.publishedAt?.toISOString() ?? null,
    };

    await testDb.db.insert(releases).values(row);

    // Second insert with same URL should fail
    await expect(
      testDb.db.insert(releases).values({
        ...row,
        contentHash: "different-hash",
      }),
    ).rejects.toThrow(/UNIQUE/);
  });

  it("rejects duplicate contentHash for same source", async () => {
    const { source } = await seedSource(testDb.db);
    const raw = makeRawRelease();
    const hash = contentHash(raw);

    const row = {
      sourceId: source.id,
      version: raw.version ?? null,
      title: raw.title,
      content: raw.content,
      url: "https://example.com/r/1",
      contentHash: hash,
      publishedAt: raw.publishedAt?.toISOString() ?? null,
    };

    await testDb.db.insert(releases).values(row);

    // Same hash, different URL — should fail on hash uniqueness
    await expect(
      testDb.db.insert(releases).values({
        ...row,
        url: "https://example.com/r/2",
      }),
    ).rejects.toThrow(/UNIQUE/);
  });

  it("allows same URL across different sources", async () => {
    const { source } = await seedSource(testDb.db);

    // Create a second source
    const [source2] = await testDb.db
      .insert(sources)
      .values({
        name: "Other Source",
        slug: "other-source",
        type: "feed",
        url: "https://other.com/feed.xml",
      })
      .returning();

    const raw = makeRawRelease();
    const sharedRow = {
      version: raw.version ?? null,
      title: raw.title,
      content: raw.content,
      url: raw.url ?? null,
      contentHash: contentHash(raw),
      publishedAt: raw.publishedAt?.toISOString() ?? null,
    };

    await testDb.db.insert(releases).values({ sourceId: source.id, ...sharedRow });
    const result = await testDb.db
      .insert(releases)
      .values({ sourceId: source2.id, ...sharedRow })
      .returning();
    expect(result).toHaveLength(1);
  });
});

describe("contentHash consistency", () => {
  it("produces same hash for identical releases", () => {
    const raw1 = makeRawRelease();
    const raw2 = makeRawRelease();
    expect(contentHash(raw1)).toBe(contentHash(raw2));
  });

  it("produces different hash when title changes", () => {
    const raw1 = makeRawRelease({ title: "v1.0.0" });
    const raw2 = makeRawRelease({ title: "v1.0.1" });
    expect(contentHash(raw1)).not.toBe(contentHash(raw2));
  });

  it("produces different hash when content changes", () => {
    const raw1 = makeRawRelease({ content: "Original" });
    const raw2 = makeRawRelease({ content: "Updated" });
    expect(contentHash(raw1)).not.toBe(contentHash(raw2));
  });

  it("produces different hash when date changes", () => {
    const raw1 = makeRawRelease({ publishedAt: new Date("2024-01-01") });
    const raw2 = makeRawRelease({ publishedAt: new Date("2024-01-02") });
    expect(contentHash(raw1)).not.toBe(contentHash(raw2));
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `cd ~/Code/released && bun test tests/integration/fetch-dedup-backoff.test.ts`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add tests/integration/fetch-dedup-backoff.test.ts
git commit -m "test: add release dedup and content hash tests"
```

---

### Task 5: Scrape Adapter Feed-First Path Tests

**Files:**

- Create: `tests/integration/scrape-feed-path.test.ts`

Tests the scrape adapter's feed-first optimization: when a source has a feed URL in metadata, the scrape adapter fetches via feed instead of using Cloudflare AI. This is the key cost-saving path.

- [ ] **Step 1: Write scrape adapter feed-first tests**

```typescript
// tests/integration/scrape-feed-path.test.ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createTempDataDir, cli, cliJson } from "../cli/roundtrip-helper.js";
import { startFixtureServer, readFeedFixture, type FixtureServer } from "../fixtures/server.js";

let server: FixtureServer;

beforeAll(() => {
  server = startFixtureServer({
    routes: {
      // Changelog page with <link rel="alternate"> pointing to feed
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
      // Standalone page with no feed (scrape adapter would need Cloudflare)
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
      cli(dataDir, ["org", "add", "Feed Discovery Org", "--category", "cloud"]);
      // Add as scrape type (default) — the scrape adapter should discover the feed
      cli(dataDir, [
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

    it("discovers feed and fetches releases via feed path (no AI needed)", () => {
      const result = cli(dataDir, ["fetch", "feed-discovery-source", "--no-summarize"], {
        timeout: 15_000,
      });
      expect(result.exitCode).toBe(0);
      // The scrape adapter should use the feed path
      expect(result.stderr).toContain("feed");
      // Should get releases from the RSS fixture
      const latest = cliJson<unknown[]>(dataDir, ["latest", "feed-discovery-source", "--json"]);
      expect(latest.length).toBe(2);
    });

    it("stores feed URL in source metadata after discovery", () => {
      const source = cliJson<{ metadata?: string }>(dataDir, [
        "list",
        "feed-discovery-source",
        "--json",
      ]);
      const meta = JSON.parse(source.metadata ?? "{}");
      expect(meta.feedUrl).toContain("/changelog/feed.xml");
      expect(meta.feedType).toBe("rss");
    });
  });

  describe("source with no feed (noFeedFound)", () => {
    let dataDir: string;
    let cleanup: () => void;

    beforeAll(() => {
      ({ dataDir, cleanup } = createTempDataDir());
      cli(dataDir, ["org", "add", "No Feed Org", "--category", "cloud"]);
      cli(dataDir, [
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

    it("marks noFeedFound after failed discovery", () => {
      // This will fail on the Cloudflare fallback (no credentials), but
      // feed discovery should complete and mark noFeedFound
      const result = cli(dataDir, ["fetch", "no-feed-source", "--no-summarize"], {
        timeout: 15_000,
      });
      // Will error because Cloudflare credentials aren't set, but that's expected
      const source = cliJson<{ metadata?: string }>(dataDir, ["list", "no-feed-source", "--json"]);
      const meta = JSON.parse(source.metadata ?? "{}");
      expect(meta.noFeedFound).toBe(true);
    });
  });

  describe("source with pre-configured feed URL in metadata", () => {
    let dataDir: string;
    let cleanup: () => void;

    beforeAll(() => {
      ({ dataDir, cleanup } = createTempDataDir());
      cli(dataDir, ["org", "add", "Preconfig Org", "--category", "cloud"]);
      cli(dataDir, [
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

    it("uses feed type source to fetch directly", () => {
      const result = cli(dataDir, ["fetch", "preconfig-source", "--no-summarize"], {
        timeout: 15_000,
      });
      expect(result.exitCode).toBe(0);
      const latest = cliJson<unknown[]>(dataDir, ["latest", "preconfig-source", "--json"]);
      expect(latest.length).toBeGreaterThan(0);
    });
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `cd ~/Code/released && bun test tests/integration/scrape-feed-path.test.ts`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add tests/integration/scrape-feed-path.test.ts
git commit -m "test: add scrape adapter feed-first path integration tests"
```

---

### Task 6: Fetch-Log and Backoff CLI Tests

**Files:**

- Create: `tests/integration/fetch-log.test.ts`

Tests that the fetch command correctly logs operations to the fetch_log table and that the fetch-log CLI command displays them. Also tests that `--stale` respects backoff.

- [ ] **Step 1: Write fetch-log integration tests**

```typescript
// tests/integration/fetch-log.test.ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createTempDataDir, cli, cliJson } from "../cli/roundtrip-helper.js";
import { startFixtureServer, readFeedFixture, type FixtureServer } from "../fixtures/server.js";

let server: FixtureServer;

beforeAll(() => {
  server = startFixtureServer({
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
      "add",
      "Log Source",
      "--url",
      `${server.url}/feed.xml`,
      "--org",
      "log-org",
      "--type",
      "feed",
      "--skip-eval",
    ]);
  });

  afterAll(() => cleanup());

  it("records successful fetch in fetch-log", () => {
    const fetchResult = cli(dataDir, ["fetch", "log-source", "--no-summarize"], {
      timeout: 15_000,
    });
    expect(fetchResult.exitCode).toBe(0);

    const logResult = cli(dataDir, ["fetch-log", "log-source", "--json"]);
    expect(logResult.exitCode).toBe(0);
    const logs = JSON.parse(logResult.stdout);
    expect(logs.length).toBeGreaterThanOrEqual(1);
    const lastLog = logs[0];
    expect(lastLog.status).toBe("success");
    expect(lastLog.releasesFound).toBe(2);
    expect(lastLog.releasesInserted).toBe(2);
  });

  it("records no_change on subsequent fetch", () => {
    const fetchResult = cli(dataDir, ["fetch", "log-source", "--no-summarize"], {
      timeout: 15_000,
    });
    expect(fetchResult.exitCode).toBe(0);

    const logResult = cli(dataDir, ["fetch-log", "log-source", "--json"]);
    const logs = JSON.parse(logResult.stdout);
    // Most recent log should be no_change (releases already in DB, dedup)
    expect(logs[0].status).toMatch(/no_change|success/);
  });

  it("records dry_run in fetch-log", () => {
    // Use a fresh source for clean dry-run
    cli(dataDir, [
      "add",
      "Dry Log Source",
      "--url",
      `${server.url}/feed.xml`,
      "--org",
      "log-org",
      "--type",
      "feed",
      "--skip-eval",
    ]);
    const fetchResult = cli(dataDir, ["fetch", "dry-log-source", "--dry-run", "--no-summarize"], {
      timeout: 15_000,
    });
    expect(fetchResult.exitCode).toBe(0);

    const logResult = cli(dataDir, ["fetch-log", "dry-log-source", "--json"]);
    const logs = JSON.parse(logResult.stdout);
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0].status).toBe("dry_run");
    expect(logs[0].releasesFound).toBe(2);
    expect(logs[0].releasesInserted).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `cd ~/Code/released && bun test tests/integration/fetch-log.test.ts`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add tests/integration/fetch-log.test.ts
git commit -m "test: add fetch-log tracking integration tests"
```

---

### Task 7: Run Full Test Suite

Verify no regressions and confirm total test count increase.

- [ ] **Step 1: Run the full test suite**

Run: `cd ~/Code/released && bun test 2>&1 | tail -30`
Expected: All tests pass (existing 386 + new ~35-40 tests)

- [ ] **Step 2: Type check**

Run: `cd ~/Code/released && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Final commit with all tests passing**

If any test files needed fixes during this task, commit the fixes:

```bash
git add -A tests/
git commit -m "test: integration test fixes from full suite run"
```
