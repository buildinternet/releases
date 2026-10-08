/**
 * The worker's GitHub ingest path (`fetchOne` → `fetchGitHub`) must honour the
 * per-source tag filter (`metadata.tagAllowPatterns` / `tagDenyPrefixes`, #923)
 * the same way the shared adapter does. Two sources can then watch one repo
 * with disjoint tag sets — e.g. the registry's own `cli` product takes `v*`
 * while the org-level `platform` source keeps `core@*` / `api-types@*`.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { applyMigrations, ensureBatchShim } from "../../../tests/db-helper";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { fetchOne } from "../src/cron/poll-fetch.js";
import { restoreGlobalFetch } from "../../../tests/global-fetch";

const RELEASES_API = "https://api.github.com/repos/buildinternet/releases/releases?per_page=100";

function installFetch() {
  (globalThis as { fetch: typeof fetch }).fetch = (async (
    input: RequestInfo | URL,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === RELEASES_API) {
      return new Response(
        JSON.stringify([
          rel("v0.83.2", "2026-10-08T22:00:00Z"),
          rel("api-types@0.58.2", "2026-10-08T21:00:00Z"),
          rel("core@0.35.1", "2026-10-05T00:00:00Z"),
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // Changelog-file refresh, stars, etc. — not under test.
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function rel(tag: string, publishedAt: string) {
  return {
    tag_name: tag,
    name: tag,
    body: `Release ${tag}`,
    html_url: `https://github.com/buildinternet/releases/releases/tag/${tag}`,
    published_at: publishedAt,
    prerelease: false,
  };
}

function mkDb() {
  const sqlite = new Database(":memory:");
  const rawDb = drizzle(sqlite);
  applyMigrations(sqlite);
  return ensureBatchShim(rawDb);
}

async function seed(db: ReturnType<typeof mkDb>, metadata: Record<string, unknown>) {
  await db
    .insert(organizations)
    .values({ id: "org_r", slug: "releases-sh", name: "Releases", category: "developer-tools" });
  await db.insert(sources).values({
    id: "src_r",
    orgId: "org_r",
    slug: "under-test",
    name: "Under test",
    type: "github",
    url: "https://github.com/buildinternet/releases",
    metadata: JSON.stringify(metadata),
  });
  const [src] = await db.select().from(sources).where(eq(sources.id, "src_r"));
  return src;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const STUB_ENV: any = {
  GITHUB_TOKEN: undefined,
  RELEASES_INDEX: undefined,
  CHANGELOG_CHUNKS_INDEX: undefined,
};

async function insertedVersions(db: ReturnType<typeof mkDb>) {
  const rows = await db.select({ version: releases.version }).from(releases);
  return rows.map((r) => r.version).sort();
}

describe("fetchOne — GitHub tag filter on the worker ingest path", () => {
  afterEach(() => {
    restoreGlobalFetch();
  });

  it("keeps only tags matching tagAllowPatterns", async () => {
    installFetch();
    const db = mkDb();
    const src = await seed(db, { tagAllowPatterns: ["^v\\d"] });

    const result = await fetchOne(db as any, src, STUB_ENV);

    expect(result.status).toBe("success");
    expect(result.releasesInserted).toBe(1);
    expect(await insertedVersions(db)).toEqual(["v0.83.2"]);
  });

  it("drops tags matching tagDenyPrefixes", async () => {
    installFetch();
    const db = mkDb();
    const src = await seed(db, { tagDenyPrefixes: ["v"] });

    const result = await fetchOne(db as any, src, STUB_ENV);

    expect(result.status).toBe("success");
    expect(result.releasesInserted).toBe(2);
    expect(await insertedVersions(db)).toEqual(["api-types@0.58.2", "core@0.35.1"]);
  });

  it("ingests everything when no filter is set", async () => {
    installFetch();
    const db = mkDb();
    const src = await seed(db, {});

    const result = await fetchOne(db as any, src, STUB_ENV);

    expect(result.releasesInserted).toBe(3);
  });
});
