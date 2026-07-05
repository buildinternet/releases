import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createTestDb, type TestDatabase, type TestDb } from "../db-helper";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import type { Source } from "@buildinternet/releases-core/schema";
import {
  delegateScrapeToUpdateWorkflow,
  type FetchOneEnv,
} from "../../workers/api/src/cron/poll-fetch.js";
import type { drizzle as drizzleD1 } from "drizzle-orm/d1";

// The poll-fetch helpers are typed against the D1 drizzle binding because
// that's how they run in production. In tests we drive them with a bun:sqlite
// drizzle instance (shape-compatible at the call sites we exercise) and cast
// at the boundary.
type D1Drizzle = ReturnType<typeof drizzleD1>;

/**
 * `delegateScrapeToUpdateWorkflow` is the summary-only feed → deterministic
 * update workflow hand-off path (#1022, re-homed by #1946). These tests
 * exercise the contract with the dispatch gate:
 *
 *   - org-name lookup is required (it labels the StatusHub session row)
 *   - the created workflow instance carries the canonical params shape
 *   - success returns a synthetic `no_change`-style `delegated` result so the
 *     workflow step terminates cleanly while the update run writes its own
 *     fetch_log rows later
 *   - dispatch refusals surface as `status: "error"`
 *
 * The behavior we care about is the params we hand the workflow, not what the
 * workflow does with them — that's covered by the workflow/dispatch tests. So
 * we stub the workflow binding entirely.
 */

// Structural stand-ins for the Workflow / DurableObjectNamespace bindings —
// the tests/ tsconfig has no Workers ambient types, and every stub is cast at
// the FetchOneEnv boundary anyway.
type WorkflowCreateCall = { id: string; params: Record<string, unknown> };

function makeWorkflowStub(): { calls: WorkflowCreateCall[]; binding: unknown } {
  const calls: WorkflowCreateCall[] = [];
  return {
    calls,
    binding: {
      create: async (opts: WorkflowCreateCall) => {
        calls.push(opts);
        return {} as never;
      },
    },
  };
}

function makeEnv(binding: unknown): FetchOneEnv {
  return { DETERMINISTIC_UPDATE_WORKFLOW: binding } as unknown as FetchOneEnv;
}

/** SOURCE_ACTOR stub whose lock is already held — dispatch refuses with `locked`. */
function lockedSourceActor(): unknown {
  return {
    idFromName: (name: string) => name,
    get: () => ({
      tryAcquireScrapeLock: async () => ({ acquired: false, sessionId: "det-owner" }),
      releaseScrapeLock: async () => {},
    }),
  };
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
  // delegateScrapeToUpdateWorkflow only reads source.id, source.orgId, and
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

describe("delegateScrapeToUpdateWorkflow", () => {
  let harness: TestDatabase;

  beforeEach(() => {
    harness = createTestDb();
  });
  afterEach(() => {
    harness.cleanup();
  });

  it("creates a workflow instance with the canonical params shape", async () => {
    const source = await seedOrgAndSource(harness.db, {
      orgName: "Notion",
      orgId: "org_notion",
      sourceId: "src_notion_releases",
      sourceSlug: "notion-releases",
    });
    const wf = makeWorkflowStub();

    await delegateScrapeToUpdateWorkflow(
      harness.db as unknown as D1Drizzle,
      source,
      makeEnv(wf.binding),
    );

    expect(wf.calls).toHaveLength(1);
    const { id, params } = wf.calls[0];
    // The dispatcher mints the sessionId, uses it as the instance id, and
    // threads it into the params so the lease owner matches the run.
    expect(id).toMatch(/^det-/);
    expect(params).toEqual({
      sessionId: id,
      company: "Notion",
      sourceIdentifiers: ["src_notion_releases"],
      orgId: "org_notion",
      correlationId: "summary-only-delegation:notion-releases",
    });
  });

  it("returns delegated on successful hand-off, carrying the minted sessionId", async () => {
    const source = await seedOrgAndSource(harness.db);
    const wf = makeWorkflowStub();

    const result = await delegateScrapeToUpdateWorkflow(
      harness.db as unknown as D1Drizzle,
      source,
      makeEnv(wf.binding),
    );

    expect(result.status).toBe("delegated");
    expect(result.releasesFound).toBe(0);
    expect(result.releasesInserted).toBe(0);
    // Narrowing: TypeScript ensures sessionId is present on the delegated variant.
    if (result.status === "delegated") {
      expect(result.sessionId).toMatch(/^det-/);
      expect(result.sessionId).toBe(wf.calls[0].id);
    }
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
    const wf = makeWorkflowStub();

    const result = await delegateScrapeToUpdateWorkflow(
      harness.db as unknown as D1Drizzle,
      orphan,
      makeEnv(wf.binding),
    );

    if (result.status !== "error") throw new Error(`expected status=error, got ${result.status}`);
    expect(result.error).toContain("org_ghost");
    expect(wf.calls).toHaveLength(0);
  });

  it("returns error when the workflow binding is missing", async () => {
    const source = await seedOrgAndSource(harness.db);
    const result = await delegateScrapeToUpdateWorkflow(
      harness.db as unknown as D1Drizzle,
      source,
      {} as unknown as FetchOneEnv,
    );

    if (result.status !== "error") throw new Error(`expected status=error, got ${result.status}`);
    expect(result.error).toContain("DETERMINISTIC_UPDATE_WORKFLOW");
  });

  it("propagates a dispatch refusal (per-source lock held) to the caller", async () => {
    const source = await seedOrgAndSource(harness.db);
    const wf = makeWorkflowStub();
    const env = {
      DETERMINISTIC_UPDATE_WORKFLOW: wf.binding,
      SOURCE_ACTOR: lockedSourceActor(),
    } as unknown as FetchOneEnv;

    const result = await delegateScrapeToUpdateWorkflow(
      harness.db as unknown as D1Drizzle,
      source,
      env,
    );

    if (result.status !== "error") throw new Error(`expected status=error, got ${result.status}`);
    expect(result.error).toContain("active update session");
    expect(wf.calls).toHaveLength(0);
  });
});
