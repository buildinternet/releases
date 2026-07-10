/**
 * `minImportance` filter on the MCP `get_latest_releases` and `whats_changed`
 * tools (#2098). Mirrors the REST `?minImportance=` contract exercised in
 * `tests/api/release-importance-filter.test.ts`: integer 1–5, inclusive at
 * the floor, unscored (`null`) rows never pass, out-of-range/non-integer
 * input is rejected rather than silently falling through.
 *
 * `get_latest_releases` applies the filter in its own D1 query (same as the
 * REST route). `whats_changed` proxies to `GET /v1/whats-changed`, which
 * doesn't carry `importance` — so the tool does a small direct D1 lookup
 * keyed by `(source_id, version)` to attach scores before filtering/
 * rendering. See `workers/mcp/src/whats-changed-tool.ts` for the rationale.
 */
import { describe, it, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { newOrgId, newSourceId, newReleaseId } from "@buildinternet/releases-core/id";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { asD1 } from "../mcp-test-helpers.js";
import { getLatestReleases } from "../../workers/mcp/src/tools.js";
import { createServer, type Env } from "../../workers/mcp/src/mcp-agent.js";

const TOKEN = "importancefilter";

async function seedReleases(db: TestDatabase["db"]) {
  const orgId = newOrgId();
  await db.insert(organizations).values({ id: orgId, name: "Acme", slug: "acme" });
  const srcId = newSourceId();
  await db.insert(sources).values({
    id: srcId,
    orgId,
    name: "Acme Releases",
    slug: "acme-releases",
    type: "github",
    url: "https://github.com/acme/releases",
    discovery: "curated",
  });
  const ids = { low: newReleaseId(), high: newReleaseId(), unscored: newReleaseId() };
  await db.insert(releases).values([
    {
      id: ids.low,
      sourceId: srcId,
      version: "1.0.0",
      title: `${TOKEN} low importance`,
      content: TOKEN,
      publishedAt: "2026-01-01T00:00:00Z",
      type: "feature",
      importance: 2,
    },
    {
      id: ids.high,
      sourceId: srcId,
      version: "2.0.0",
      title: `${TOKEN} high importance`,
      content: TOKEN,
      publishedAt: "2026-02-01T00:00:00Z",
      type: "feature",
      importance: 5,
    },
    {
      id: ids.unscored,
      sourceId: srcId,
      version: "3.0.0",
      title: `${TOKEN} unscored`,
      content: TOKEN,
      publishedAt: "2026-03-01T00:00:00Z",
      type: "feature",
      importance: null,
    },
  ]);
  return { orgId, srcId, ids };
}

describe("get_latest_releases — minImportance", () => {
  it("filters out releases scored below the threshold and excludes unscored rows", async () => {
    const testDb = createTestDb();
    try {
      await seedReleases(testDb.db);
      const out = await getLatestReleases(asD1(testDb.db), { minImportance: 4 });
      const text = out.content[0].text;
      expect(text).toContain("high importance");
      expect(text).not.toContain("low importance");
      expect(text).not.toContain("unscored");
    } finally {
      testDb.cleanup();
    }
  });

  it("minImportance=1 is inclusive of every scored release but still excludes unscored", async () => {
    const testDb = createTestDb();
    try {
      await seedReleases(testDb.db);
      const out = await getLatestReleases(asD1(testDb.db), { minImportance: 1 });
      const text = out.content[0].text;
      expect(text).toContain("low importance");
      expect(text).toContain("high importance");
      expect(text).not.toContain("unscored");
    } finally {
      testDb.cleanup();
    }
  });

  it("an exact-boundary threshold includes the release scored at that value", async () => {
    const testDb = createTestDb();
    try {
      await seedReleases(testDb.db);
      const out = await getLatestReleases(asD1(testDb.db), { minImportance: 5 });
      const text = out.content[0].text;
      expect(text).toContain("high importance");
      expect(text).not.toContain("low importance");
    } finally {
      testDb.cleanup();
    }
  });

  it("rejects an out-of-range minImportance with a model-readable message", async () => {
    const testDb = createTestDb();
    try {
      await seedReleases(testDb.db);
      const tooHigh = await getLatestReleases(asD1(testDb.db), { minImportance: 6 });
      expect(tooHigh.content[0].text).toMatch(/minImportance.*between 1 and 5/);

      const tooLow = await getLatestReleases(asD1(testDb.db), { minImportance: 0 });
      expect(tooLow.content[0].text).toMatch(/minImportance.*between 1 and 5/);
    } finally {
      testDb.cleanup();
    }
  });

  it("rejects a non-integer minImportance", async () => {
    const testDb = createTestDb();
    try {
      await seedReleases(testDb.db);
      const out = await getLatestReleases(asD1(testDb.db), { minImportance: 2.5 });
      expect(out.content[0].text).toMatch(/minImportance.*between 1 and 5/);
    } finally {
      testDb.cleanup();
    }
  });

  it("renders Importance: N/5 in the text output, omitted when unscored", async () => {
    const testDb = createTestDb();
    try {
      await seedReleases(testDb.db);
      const out = await getLatestReleases(asD1(testDb.db), {});
      const text = out.content[0].text;
      expect(text).toContain("Importance: 5/5");
      expect(text).toContain("Importance: 2/5");
    } finally {
      testDb.cleanup();
    }
  });
});

// ── whats_changed ────────────────────────────────────────────────────

type WhatsChangedEntryStub = {
  version: string;
  publishedAt: string | null;
  title: string;
  summary: string | null;
  breaking: "unknown";
  migrationNotes: null;
  url: null;
  webUrl: null;
};

function stubEnv(over: Partial<Env>): Env {
  return {
    RELEASES_INDEX: {} as Env["RELEASES_INDEX"],
    ENTITIES_INDEX: {} as Env["ENTITIES_INDEX"],
    CHANGELOG_CHUNKS_INDEX: {} as Env["CHANGELOG_CHUNKS_INDEX"],
    ...over,
  } as Env;
}

/** Stub `env.API` that answers `/v1/whats-changed` with a canned resolved response
 *  (no `importance` field — mirrors the real REST route, which doesn't carry one). */
function stubWhatsChangedApi(sourceId: string, entries: WhatsChangedEntryStub[]): Env["API"] {
  return {
    fetch: async () =>
      new Response(
        JSON.stringify({
          status: "resolved",
          package: "acme-releases",
          ecosystem: null,
          from: "0.9.0",
          to: "3.0.0",
          source: { sourceId, sourceSlug: "acme-releases", orgSlug: "acme" },
          entries,
          count: entries.length,
          truncated: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  } as unknown as Env["API"];
}

async function withClient(env: Env) {
  const server = await createServer(env);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { client, close: () => client.close() };
}

function firstText(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.find((c) => c.type === "text")?.text ?? "";
}

function entriesFor(): WhatsChangedEntryStub[] {
  return [
    {
      version: "1.0.0",
      publishedAt: "2026-01-01T00:00:00Z",
      title: `${TOKEN} low importance`,
      summary: null,
      breaking: "unknown",
      migrationNotes: null,
      url: null,
      webUrl: null,
    },
    {
      version: "2.0.0",
      publishedAt: "2026-02-01T00:00:00Z",
      title: `${TOKEN} high importance`,
      summary: null,
      breaking: "unknown",
      migrationNotes: null,
      url: null,
      webUrl: null,
    },
    {
      version: "3.0.0",
      publishedAt: "2026-03-01T00:00:00Z",
      title: `${TOKEN} unscored`,
      summary: null,
      breaking: "unknown",
      migrationNotes: null,
      url: null,
      webUrl: null,
    },
  ];
}

describe("whats_changed — minImportance", () => {
  it("attaches importance from D1 and renders Importance: N/5, omitted when unscored", async () => {
    const testDb = createTestDb();
    try {
      const { srcId } = await seedReleases(testDb.db);
      const env = stubEnv({
        DB: asD1(testDb.db) as unknown as Env["DB"],
        API: stubWhatsChangedApi(srcId, entriesFor()),
      });
      const { client, close } = await withClient(env);
      try {
        const res = await client.callTool({
          name: "whats_changed",
          arguments: { package: "acme-releases", from: "0.9.0", to: "3.0.0" },
        });
        const text = firstText(res);
        expect(text).toContain("[Importance: 2/5]");
        expect(text).toContain("[Importance: 5/5]");
        // The unscored entry (version 3.0.0, importance null) gets no tag.
        expect(text).not.toContain("[Importance: null");
        const unscoredLine = text.split("\n").find((l) => l.includes("3.0.0"));
        expect(unscoredLine).not.toContain("Importance");
      } finally {
        await close();
      }
    } finally {
      testDb.cleanup();
    }
  });

  it("minImportance filters entries below the threshold and drops unscored ones", async () => {
    const testDb = createTestDb();
    try {
      const { srcId } = await seedReleases(testDb.db);
      const env = stubEnv({
        DB: asD1(testDb.db) as unknown as Env["DB"],
        API: stubWhatsChangedApi(srcId, entriesFor()),
      });
      const { client, close } = await withClient(env);
      try {
        const res = await client.callTool({
          name: "whats_changed",
          arguments: {
            package: "acme-releases",
            from: "0.9.0",
            to: "3.0.0",
            minImportance: 4,
          },
        });
        const text = firstText(res);
        expect(text).toContain("high importance");
        expect(text).not.toContain("low importance");
        expect(text).not.toContain("2026-03-01");
      } finally {
        await close();
      }
    } finally {
      testDb.cleanup();
    }
  });

  it("minImportance=1 includes every scored entry but still excludes unscored", async () => {
    const testDb = createTestDb();
    try {
      const { srcId } = await seedReleases(testDb.db);
      const env = stubEnv({
        DB: asD1(testDb.db) as unknown as Env["DB"],
        API: stubWhatsChangedApi(srcId, entriesFor()),
      });
      const { client, close } = await withClient(env);
      try {
        const res = await client.callTool({
          name: "whats_changed",
          arguments: {
            package: "acme-releases",
            from: "0.9.0",
            to: "3.0.0",
            minImportance: 1,
          },
        });
        const text = firstText(res);
        expect(text).toContain("low importance");
        expect(text).toContain("high importance");
        expect(text).not.toContain("unscored");
      } finally {
        await close();
      }
    } finally {
      testDb.cleanup();
    }
  });

  it("rejects an out-of-range or non-integer minImportance before calling the API", async () => {
    const testDb = createTestDb();
    try {
      const { srcId } = await seedReleases(testDb.db);
      const calls: string[] = [];
      const env = stubEnv({
        DB: asD1(testDb.db) as unknown as Env["DB"],
        API: {
          fetch: async (req: Request) => {
            calls.push(req.url);
            return new Response(
              JSON.stringify({
                status: "resolved",
                package: "acme-releases",
                ecosystem: null,
                from: "0.9.0",
                to: "3.0.0",
                source: { sourceId: srcId, sourceSlug: "acme-releases", orgSlug: "acme" },
                entries: entriesFor(),
                count: 3,
                truncated: false,
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          },
        } as unknown as Env["API"],
      });
      const { client, close } = await withClient(env);
      try {
        for (const bad of [6, 0, 2.5, "abc"]) {
          calls.length = 0;
          let threw = false;
          try {
            await client.callTool({
              name: "whats_changed",
              arguments: {
                package: "acme-releases",
                from: "0.9.0",
                to: "3.0.0",
                minImportance: bad,
              },
            });
          } catch {
            threw = true;
          }
          // Either the MCP SDK rejects the call before it reaches our handler
          // (zod schema bound) or our handler's own defensive check does — either
          // way the API must never be called with a filter it can't honor.
          expect(calls.length).toBe(0);
          void threw;
        }
      } finally {
        await close();
      }
    } finally {
      testDb.cleanup();
    }
  });
});
