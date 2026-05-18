import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createTestDb, type TestDatabase, type TestDb } from "../db-helper";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import type { Source } from "@buildinternet/releases-core/schema";
import {
  delegateScrapeToDiscovery,
  type DiscoveryWorkerRpc,
  type FetchOneEnv,
} from "../../workers/api/src/cron/poll-fetch.js";
import type { drizzle as drizzleD1 } from "drizzle-orm/d1";

// The poll-fetch helpers are typed against the D1 drizzle binding because
// that's how they run in production. In tests we drive them with a bun:sqlite
// drizzle instance (shape-compatible at the call sites we exercise) and cast
// at the boundary.
type D1Drizzle = ReturnType<typeof drizzleD1>;

/**
 * `delegateScrapeToDiscovery` is the summary-only feed → managed-agent worker
 * hand-off path (#1022). These tests exercise the contract with discovery:
 *
 *   - org-name lookup is required (it keys MA session dedup)
 *   - `startManagedFetchSession` is called with the canonical body shape
 *   - success returns a synthetic `no_change` so the workflow step terminates
 *     cleanly while the MA session writes its own fetch_log row later
 *   - failures from discovery surface as `status: "error"`
 *
 * The behavior we care about is the body shape we put on the wire to
 * discovery, not what discovery does with it — that's covered separately by
 * the MA session and ingest tests. So we stub the RPC entirely.
 */

interface DiscoveryStub extends DiscoveryWorkerRpc {
  calls: Array<Parameters<DiscoveryWorkerRpc["startManagedFetchSession"]>[0]>;
}

function makeDiscoveryStub(
  result: Awaited<ReturnType<DiscoveryWorkerRpc["startManagedFetchSession"]>>,
): DiscoveryStub {
  const calls: DiscoveryStub["calls"] = [];
  return {
    calls,
    async startManagedFetchSession(params) {
      calls.push(params);
      return result;
    },
  };
}

function makeEnv(discovery: DiscoveryWorkerRpc): FetchOneEnv {
  return { DISCOVERY_WORKER: discovery } as unknown as FetchOneEnv;
}

async function seedOrgAndSource(
  db: TestDb,
  overrides?: { orgName?: string; sourceSlug?: string; orgId?: string; sourceId?: string },
): Promise<Source> {
  const orgId = overrides?.orgId ?? "org_acme";
  const orgName = overrides?.orgName ?? "Acme Corp";
  const sourceId = overrides?.sourceId ?? "src_acme_changelog";
  const sourceSlug = overrides?.sourceSlug ?? "acme-changelog";

  await db.insert(organizations).values({
    id: orgId,
    name: orgName,
    slug: orgName.toLowerCase().replace(/\s+/g, "-"),
    createdAt: new Date().toISOString(),
  });
  await db.insert(sources).values({
    id: sourceId,
    orgId,
    slug: sourceSlug,
    name: "Acme Changelog",
    type: "scrape",
    url: "https://acme.example.com/changelog",
    createdAt: new Date().toISOString(),
  });
  // delegateScrapeToDiscovery only reads source.id, source.orgId, and
  // source.slug, so constructing the Source from the inserted values is both
  // faster than a readback and explicit about which fields the test cares
  // about. A WHERE-less SELECT here would also be ambiguous if seedOrg is
  // ever called twice in one test.
  return {
    id: sourceId,
    orgId,
    slug: sourceSlug,
    name: "Acme Changelog",
    type: "scrape",
    url: "https://acme.example.com/changelog",
    productId: null,
    metadata: null,
    createdAt: new Date().toISOString(),
  } as unknown as Source;
}

describe("delegateScrapeToDiscovery", () => {
  let harness: TestDatabase;

  beforeEach(() => {
    harness = createTestDb();
  });
  afterEach(() => {
    harness.cleanup();
  });

  it("posts the canonical {sourceIds, company, orgId, correlationId} shape to discovery", async () => {
    const source = await seedOrgAndSource(harness.db, {
      orgName: "Notion",
      orgId: "org_notion",
      sourceId: "src_notion_releases",
      sourceSlug: "notion-releases",
    });
    const discovery = makeDiscoveryStub({ ok: true, sessionId: "ma-abc123" });

    await delegateScrapeToDiscovery(harness.db as unknown as D1Drizzle, source, makeEnv(discovery));

    expect(discovery.calls).toHaveLength(1);
    expect(discovery.calls[0]).toEqual({
      sourceIds: ["src_notion_releases"],
      company: "Notion",
      orgId: "org_notion",
      correlationId: "summary-only-delegation:notion-releases",
    });
  });

  it("returns synthetic no_change on successful hand-off (MA writes its own fetch_log later)", async () => {
    const source = await seedOrgAndSource(harness.db);
    const discovery = makeDiscoveryStub({ ok: true, sessionId: "ma-xyz" });

    const result = await delegateScrapeToDiscovery(
      harness.db as unknown as D1Drizzle,
      source,
      makeEnv(discovery),
    );

    expect(result.status).toBe("no_change");
    expect(result.releasesFound).toBe(0);
    expect(result.releasesInserted).toBe(0);
    expect(result.error).toBeUndefined();
  });

  it("returns error when the org row is missing (orphaned source)", async () => {
    // Insert a source without its parent org row — simulates an upstream
    // bookkeeping bug we'd rather see in logs than silently swallow.
    const orphan: Source = {
      id: "src_orphan",
      orgId: "org_ghost",
      slug: "orphan",
      name: "Orphan",
      type: "scrape",
      url: "https://orphan.example.com",
      productId: null,
      metadata: null,
      createdAt: new Date().toISOString(),
    } as unknown as Source;
    const discovery = makeDiscoveryStub({ ok: true, sessionId: "should-not-be-called" });

    const result = await delegateScrapeToDiscovery(
      harness.db as unknown as D1Drizzle,
      orphan,
      makeEnv(discovery),
    );

    expect(result.status).toBe("error");
    expect(result.error).toContain("org_ghost");
    expect(discovery.calls).toHaveLength(0);
  });

  it("returns error when DISCOVERY_WORKER binding is missing", async () => {
    const source = await seedOrgAndSource(harness.db);
    const result = await delegateScrapeToDiscovery(
      harness.db as unknown as D1Drizzle,
      source,
      {} as unknown as FetchOneEnv,
    );

    expect(result.status).toBe("error");
    expect(result.error).toContain("DISCOVERY_WORKER");
  });

  it("propagates discovery's ok:false error message to the caller", async () => {
    const source = await seedOrgAndSource(harness.db);
    const discovery = makeDiscoveryStub({
      ok: false,
      error: "ANTHROPIC_API_KEY not configured",
    });

    const result = await delegateScrapeToDiscovery(
      harness.db as unknown as D1Drizzle,
      source,
      makeEnv(discovery),
    );

    expect(result.status).toBe("error");
    expect(result.error).toBe("ANTHROPIC_API_KEY not configured");
    expect(discovery.calls).toHaveLength(1);
  });
});
