/**
 * Tests for the render dry-run probe (#1528): renderCheckOne renders a
 * client-rendered scrape source's index once and reports candidate links found,
 * without the managed-agent extraction loop.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { applyMigrations, ensureBatchShim } from "../../../tests/db-helper.js";
import { organizations, sources, fetchLog } from "@buildinternet/releases-core/schema";

const { renderCheckOne, extractCandidateLinks } = await import("../src/cron/poll-fetch.js");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
const realFetch = globalThis.fetch;

beforeEach(() => {
  const sqlite = new Database(":memory:");
  db = ensureBatchShim(drizzle(sqlite));
  applyMigrations(sqlite);
  db.insert(organizations).values({ id: "org_1", name: "Acme", slug: "acme" }).run();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function seedSource(url = "https://example.com/release-notes") {
  db.insert(sources)
    .values({
      id: "src_1",
      orgId: "org_1",
      name: "Acme Releases",
      slug: "acme-releases",
      type: "scrape",
      url,
      metadata: JSON.stringify({ crawlEnabled: true, renderRequired: true }),
    })
    .run();
  return db.select().from(sources).where(eq(sources.id, "src_1")).get();
}

// Stub the CF Browser Rendering /markdown endpoint.
function stubRender(markdown: string | null, ok = true) {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify(
        ok && markdown != null ? { success: true, result: markdown } : { success: false },
      ),
      { status: ok ? 200 : 500, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
}

const creds = {
  CLOUDFLARE_ACCOUNT_ID: { get: async () => "acct" },
  CLOUDFLARE_API_TOKEN: { get: async () => "token" },
};

describe("extractCandidateLinks", () => {
  it("counts distinct same-origin links, excluding the index itself and off-origin", () => {
    const md = `
[Release A](https://example.com/release-notes/a)
[Release B](https://example.com/release-notes/b)
[Home](https://example.com/release-notes)
[Twitter](https://twitter.com/acme)
bare https://example.com/release-notes/c
duplicate https://example.com/release-notes/a
`;
    const links = extractCandidateLinks(md, "https://example.com/release-notes");
    expect(links.toSorted()).toEqual([
      "https://example.com/release-notes/a",
      "https://example.com/release-notes/b",
      "https://example.com/release-notes/c",
    ]);
  });

  it("returns [] for an empty-shell render", () => {
    expect(extractCandidateLinks("", "https://example.com/x")).toEqual([]);
    expect(extractCandidateLinks("no links here", "https://example.com/x")).toEqual([]);
  });

  it("returns [] for an unparseable base URL", () => {
    expect(extractCandidateLinks("[a](https://x.com/a)", "not a url")).toEqual([]);
  });
});

describe("renderCheckOne", () => {
  it("reports candidate count from a successful render and writes a dry_run log row", async () => {
    const src = seedSource();
    stubRender(`
[A](https://example.com/release-notes/a)
[B](https://example.com/release-notes/b)
`);
    const res = await renderCheckOne(db, src, creds);
    expect(res.status).toBe("dry_run");
    expect(res.rendered).toBe(true);
    expect(res.candidateCount).toBe(2);
    expect(res.sampleUrls.length).toBe(2);

    const logs = db.select().from(fetchLog).where(eq(fetchLog.sourceId, "src_1")).all();
    expect(logs.length).toBe(1);
    expect(logs[0].status).toBe("dry_run");
    expect(logs[0].releasesFound).toBe(2);
    expect(logs[0].releasesInserted).toBe(0);
  });

  it("reports rendered:false with 0 candidates when the render fails (no extraction)", async () => {
    const src = seedSource();
    stubRender(null, /* ok */ false);
    const res = await renderCheckOne(db, src, creds);
    expect(res.status).toBe("dry_run");
    expect(res.rendered).toBe(false);
    expect(res.candidateCount).toBe(0);
  });

  it("returns an error result when Browser Rendering credentials are absent", async () => {
    const src = seedSource();
    const res = await renderCheckOne(db, src, {});
    expect(res.status).toBe("error");
    expect(res.rendered).toBe(false);
    expect(res.error).toMatch(/credentials/i);
    // No fetch_log row written when we never rendered.
    const logs = db.select().from(fetchLog).where(eq(fetchLog.sourceId, "src_1")).all();
    expect(logs.length).toBe(0);
  });
});
