import { describe, it, expect, mock, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations } from "../../../tests/db-helper";
import { eq } from "drizzle-orm";
import { organizations, sources, knowledgePages } from "@buildinternet/releases-core/schema";

/**
 * Exercises the #517 change-detector branch of `pollOne`:
 *   - scrape-no-feed / agent with `fetchQuirks.<slug>.changeDetector=etag`
 *     routes to `headCheckUrl` and updates `changeDetectedAt` + `pageEtag`.
 *   - `body-hash` routes to `bodyHashCheck` and updates `pageContentHash`.
 *   - `unreliable` is a pure no-op (no `changeDetectedAt` write).
 *   - Sources whose playbook has no quirk fall through to no-op.
 *   - The feature flag gates the whole branch — disabled → no-op, stays out
 *     of the sweep's inbox.
 */

type HeadCheckStub = (
  url: string,
  stored: { etag?: string; lastModified?: string; contentLength?: string },
) => Promise<{
  status: "changed" | "unchanged" | "unknown";
  etag?: string;
  lastModified?: string;
  contentLength?: string;
  responseMs: number;
}>;

type BodyHashStub = (
  url: string,
  storedHash: string | undefined,
  opts?: { filter?: boolean },
) => Promise<{
  status: "changed" | "unchanged" | "unknown";
  contentHash?: string;
  responseMs: number;
}>;

let headCheckImpl: HeadCheckStub = async () => ({ status: "unchanged", responseMs: 1 });
let bodyHashImpl: BodyHashStub = async () => ({ status: "unchanged", responseMs: 1 });
let headCheckCalls: Array<{ url: string; stored: Record<string, string | undefined> }> = [];
let bodyHashCalls: Array<{
  url: string;
  storedHash: string | undefined;
  opts?: { filter?: boolean };
}> = [];

mock.module("@releases/adapters/feed.js", () => ({
  FEED_4XX_INVALIDATE_THRESHOLD: 3,
  CLEARED_FEED_FIELDS: {},
  getSourceMeta: (src: { metadata: string | null }) =>
    src.metadata ? JSON.parse(src.metadata) : {},
  headCheckUrl: (async (url, stored) => {
    headCheckCalls.push({ url, stored });
    return headCheckImpl(url, stored);
  }) satisfies HeadCheckStub,
  bodyHashCheck: (async (url, storedHash, opts) => {
    bodyHashCalls.push({ url, storedHash, opts });
    return bodyHashImpl(url, storedHash, opts);
  }) satisfies BodyHashStub,
  fetchAndParseFeed: async () => ({
    releases: [],
    etag: null,
    lastModified: null,
    contentLength: null,
  }),
}));

const { pollOne, loadPlaybookNotesForSources } = await import("../src/cron/poll-fetch.js");

function mkDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  applyMigrations(sqlite);
  return db;
}

function seedOrgWithSource(
  db: ReturnType<typeof mkDb>,
  opts: {
    orgId: string;
    orgSlug: string;
    orgName: string;
    sourceId: string;
    sourceSlug: string;
    sourceType?: "scrape" | "agent";
    sourceUrl: string;
    metadata?: Record<string, unknown>;
    playbookNotes?: string | null;
  },
) {
  db.insert(organizations).values({ id: opts.orgId, name: opts.orgName, slug: opts.orgSlug }).run();
  db.insert(sources)
    .values({
      id: opts.sourceId,
      orgId: opts.orgId,
      name: opts.sourceSlug,
      slug: opts.sourceSlug,
      type: opts.sourceType ?? "scrape",
      url: opts.sourceUrl,
      metadata: JSON.stringify(opts.metadata ?? {}),
    } as any)
    .run();
  if (opts.playbookNotes !== undefined) {
    db.insert(knowledgePages)
      .values({
        scope: "playbook",
        orgId: opts.orgId,
        content: "## Sources\n\n",
        notes: opts.playbookNotes,
      } as any)
      .run();
  }
}

function readSource(db: ReturnType<typeof mkDb>, id: string) {
  const [row] = db.select().from(sources).where(eq(sources.id, id)).all();
  return row;
}

function readSourceMeta(db: ReturnType<typeof mkDb>, id: string): Record<string, unknown> {
  const row = readSource(db, id);
  return row.metadata ? JSON.parse(row.metadata) : {};
}

const ETAG_QUIRK_NOTES = `---
fetchQuirks:
  brex:
    changeDetector: etag
    rationale: ETag stable across HEADs
---

### Fetch instructions

Brex publishes weekly.`;

const BODY_HASH_QUIRK_NOTES = `---
fetchQuirks:
  brex-developer-api:
    changeDetector: body-hash
    rationale: No HEAD validator; GET body SHA-256 stable
    tier: low
---
`;

const UNRELIABLE_QUIRK_NOTES = `---
fetchQuirks:
  claude:
    changeDetector: unreliable
    rationale: SSR nonces; body hash churns
---
`;

const BODY_HASH_FILTERED_QUIRK_NOTES = `---
fetchQuirks:
  lightfield:
    changeDetector: body-hash-filtered
    rationale: Next.js SSR; article markup stable after stripping scripts/hydration
---
`;

beforeEach(() => {
  headCheckImpl = async () => ({ status: "unchanged", responseMs: 1 });
  bodyHashImpl = async () => ({ status: "unchanged", responseMs: 1 });
  headCheckCalls = [];
  bodyHashCalls = [];
});

describe("pollOne — scrape/agent change detectors (#517)", () => {
  it("etag quirk: changed HEAD sets changeDetectedAt and persists pageEtag", async () => {
    const db = mkDb();
    seedOrgWithSource(db, {
      orgId: "org_1",
      orgSlug: "brex",
      orgName: "Brex",
      sourceId: "src_brex",
      sourceSlug: "brex",
      sourceUrl: "https://brex.com/changelog",
      playbookNotes: ETAG_QUIRK_NOTES,
    });

    headCheckImpl = async () => ({
      status: "changed",
      etag: "new-etag",
      responseMs: 10,
    });

    const notesMap = await loadPlaybookNotesForSources(db as any, [
      readSource(db, "src_brex") as any,
    ]);
    const source = readSource(db, "src_brex");

    const result = await pollOne(db as any, source as any, new Date(), {
      changeDetectEnabled: true,
      playbookNotes: notesMap.get(source.orgId!) ?? null,
    });

    expect(result.changed).toBe(true);
    expect(headCheckCalls).toHaveLength(1);
    expect(headCheckCalls[0].url).toBe("https://brex.com/changelog");

    const after = readSource(db, "src_brex");
    expect(after.changeDetectedAt).not.toBeNull();
    expect(readSourceMeta(db, "src_brex").pageEtag).toBe("new-etag");
  });

  it("etag quirk: unchanged HEAD does NOT set changeDetectedAt", async () => {
    const db = mkDb();
    seedOrgWithSource(db, {
      orgId: "org_1",
      orgSlug: "brex",
      orgName: "Brex",
      sourceId: "src_brex",
      sourceSlug: "brex",
      sourceUrl: "https://brex.com/changelog",
      metadata: { pageEtag: "prior-etag" },
      playbookNotes: ETAG_QUIRK_NOTES,
    });

    headCheckImpl = async () => ({
      status: "unchanged",
      etag: "prior-etag",
      responseMs: 10,
    });

    const notesMap = await loadPlaybookNotesForSources(db as any, [
      readSource(db, "src_brex") as any,
    ]);
    const source = readSource(db, "src_brex");

    const result = await pollOne(db as any, source as any, new Date(), {
      changeDetectEnabled: true,
      playbookNotes: notesMap.get(source.orgId!) ?? null,
    });

    expect(result.changed).toBe(false);
    const after = readSource(db, "src_brex");
    expect(after.changeDetectedAt).toBeNull();
  });

  it("body-hash quirk: routes to bodyHashCheck and persists pageContentHash on change", async () => {
    const db = mkDb();
    seedOrgWithSource(db, {
      orgId: "org_2",
      orgSlug: "brex-api",
      orgName: "Brex API",
      sourceId: "src_brex_api",
      sourceSlug: "brex-developer-api",
      sourceUrl: "https://brex.com/docs",
      metadata: { pageContentHash: "old-hash" },
      playbookNotes: BODY_HASH_QUIRK_NOTES,
    });

    bodyHashImpl = async () => ({
      status: "changed",
      contentHash: "new-hash",
      responseMs: 20,
    });

    const notesMap = await loadPlaybookNotesForSources(db as any, [
      readSource(db, "src_brex_api") as any,
    ]);
    const source = readSource(db, "src_brex_api");

    const result = await pollOne(db as any, source as any, new Date(), {
      changeDetectEnabled: true,
      playbookNotes: notesMap.get(source.orgId!) ?? null,
    });

    expect(result.changed).toBe(true);
    expect(bodyHashCalls).toHaveLength(1);
    expect(bodyHashCalls[0].storedHash).toBe("old-hash");
    expect(headCheckCalls).toHaveLength(0);

    const after = readSource(db, "src_brex_api");
    expect(after.changeDetectedAt).not.toBeNull();
    expect(readSourceMeta(db, "src_brex_api").pageContentHash).toBe("new-hash");
  });

  it("body-hash-filtered quirk: routes to bodyHashCheck with filter:true and persists pageContentHash", async () => {
    const db = mkDb();
    seedOrgWithSource(db, {
      orgId: "org_lf",
      orgSlug: "lightfield",
      orgName: "Lightfield",
      sourceId: "src_lightfield",
      sourceSlug: "lightfield",
      sourceUrl: "https://lightfield.app/blog?category=changelog",
      metadata: { pageContentHash: "old-hash" },
      playbookNotes: BODY_HASH_FILTERED_QUIRK_NOTES,
    });

    bodyHashImpl = async () => ({
      status: "changed",
      contentHash: "filtered-new-hash",
      responseMs: 25,
    });

    const notesMap = await loadPlaybookNotesForSources(db as any, [
      readSource(db, "src_lightfield") as any,
    ]);
    const source = readSource(db, "src_lightfield");

    const result = await pollOne(db as any, source as any, new Date(), {
      changeDetectEnabled: true,
      playbookNotes: notesMap.get(source.orgId!) ?? null,
    });

    expect(result.changed).toBe(true);
    expect(bodyHashCalls).toHaveLength(1);
    expect(bodyHashCalls[0].storedHash).toBe("old-hash");
    expect(bodyHashCalls[0].opts).toEqual({ filter: true });
    expect(headCheckCalls).toHaveLength(0);

    const after = readSource(db, "src_lightfield");
    expect(after.changeDetectedAt).not.toBeNull();
    expect(readSourceMeta(db, "src_lightfield").pageContentHash).toBe("filtered-new-hash");
  });

  it("unreliable quirk: no probe, no changeDetectedAt", async () => {
    const db = mkDb();
    seedOrgWithSource(db, {
      orgId: "org_3",
      orgSlug: "anthropic",
      orgName: "Anthropic",
      sourceId: "src_claude",
      sourceSlug: "claude",
      sourceUrl: "https://claude.com/release-notes",
      playbookNotes: UNRELIABLE_QUIRK_NOTES,
    });

    const notesMap = await loadPlaybookNotesForSources(db as any, [
      readSource(db, "src_claude") as any,
    ]);
    const source = readSource(db, "src_claude");

    const result = await pollOne(db as any, source as any, new Date(), {
      changeDetectEnabled: true,
      playbookNotes: notesMap.get(source.orgId!) ?? null,
    });

    expect(result.changed).toBe(false);
    expect(headCheckCalls).toHaveLength(0);
    expect(bodyHashCalls).toHaveLength(0);

    const after = readSource(db, "src_claude");
    expect(after.changeDetectedAt).toBeNull();
    expect(after.lastPolledAt).not.toBeNull();
  });

  it("no quirk entry for this slug: treated as unreliable (no-op)", async () => {
    const db = mkDb();
    seedOrgWithSource(db, {
      orgId: "org_4",
      orgSlug: "orphan",
      orgName: "Orphan",
      sourceId: "src_orphan",
      sourceSlug: "orphan",
      sourceUrl: "https://orphan.com/releases",
      playbookNotes: null, // no frontmatter at all
    });

    const notesMap = await loadPlaybookNotesForSources(db as any, [
      readSource(db, "src_orphan") as any,
    ]);
    const source = readSource(db, "src_orphan");

    const result = await pollOne(db as any, source as any, new Date(), {
      changeDetectEnabled: true,
      playbookNotes: notesMap.get(source.orgId!) ?? null,
    });

    expect(result.changed).toBe(false);
    expect(headCheckCalls).toHaveLength(0);
  });

  it("flag disabled: no probe, no changeDetectedAt, even when quirk exists", async () => {
    const db = mkDb();
    seedOrgWithSource(db, {
      orgId: "org_5",
      orgSlug: "brex",
      orgName: "Brex",
      sourceId: "src_brex",
      sourceSlug: "brex",
      sourceUrl: "https://brex.com/changelog",
      playbookNotes: ETAG_QUIRK_NOTES,
    });

    const source = readSource(db, "src_brex");

    const result = await pollOne(db as any, source as any, new Date(), {
      changeDetectEnabled: false,
      playbookNotes: ETAG_QUIRK_NOTES,
    });

    expect(result.changed).toBe(false);
    expect(headCheckCalls).toHaveLength(0);

    const after = readSource(db, "src_brex");
    expect(after.changeDetectedAt).toBeNull();
    expect(after.lastPolledAt).not.toBeNull();
  });

  it("changeProbeUrl override: HEAD hits the alternate target, not source.url", async () => {
    const db = mkDb();
    const notes = `---
fetchQuirks:
  brex:
    changeDetector: etag
    rationale: Use API endpoint instead of HTML page
    changeProbeUrl: https://brex.com/api/changelog.json
---
`;
    seedOrgWithSource(db, {
      orgId: "org_6",
      orgSlug: "brex",
      orgName: "Brex",
      sourceId: "src_brex",
      sourceSlug: "brex",
      sourceUrl: "https://brex.com/changelog",
      playbookNotes: notes,
    });

    headCheckImpl = async () => ({
      status: "unchanged",
      etag: "e1",
      responseMs: 5,
    });

    const notesMap = await loadPlaybookNotesForSources(db as any, [
      readSource(db, "src_brex") as any,
    ]);
    const source = readSource(db, "src_brex");

    await pollOne(db as any, source as any, new Date(), {
      changeDetectEnabled: true,
      playbookNotes: notesMap.get(source.orgId!) ?? null,
    });

    expect(headCheckCalls[0].url).toBe("https://brex.com/api/changelog.json");
  });
});

describe("loadPlaybookNotesForSources", () => {
  it("returns a single query's worth of rows regardless of source count", async () => {
    const db = mkDb();
    for (let i = 0; i < 3; i++) {
      db.insert(organizations)
        .values({ id: `org_${i}`, name: `Org ${i}`, slug: `org-${i}` })
        .run();
      db.insert(knowledgePages)
        .values({
          scope: "playbook",
          orgId: `org_${i}`,
          content: "",
          notes: `notes-for-org-${i}`,
        } as any)
        .run();
    }

    const sourcesList = [0, 0, 1, 2].map((i) => ({ orgId: `org_${i}` }));
    const result = await loadPlaybookNotesForSources(db as any, sourcesList as any);

    expect(result.size).toBe(3);
    expect(result.get("org_0")).toBe("notes-for-org-0");
    expect(result.get("org_1")).toBe("notes-for-org-1");
    expect(result.get("org_2")).toBe("notes-for-org-2");
  });

  it("returns an empty map when no sources carry an orgId", async () => {
    const db = mkDb();
    const result = await loadPlaybookNotesForSources(db as any, [{ orgId: null }] as any);
    expect(result.size).toBe(0);
  });
});
