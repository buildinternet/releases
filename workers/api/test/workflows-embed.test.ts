/**
 * Tests for POST /v1/workflows/embed-{releases,entities,changelogs}.
 *
 * These tests exercise the moved backfill endpoints. The embed helpers
 * (embedAndUpsertReleases, embedAndUpsertEntities, embedAndUpsertChangelogFile)
 * are mocked so the tests stay offline and fast.
 */
import { describe, it, expect, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations } from "../../../tests/db-helper";
import {
  organizations,
  sources,
  releases,
  sourceChangelogFiles,
} from "@buildinternet/releases-core/schema";

// ── mock embed helpers ────────────────────────────────────────────────────────

type OnPersisted = (ids: string[]) => Promise<void>;

mock.module("@releases/lib/embed-releases.js", () => ({
  embedAndUpsertReleases: async ({ onPersisted }: { onPersisted: OnPersisted }) => {
    // no-op: pretend nothing was embedded
    await onPersisted([]);
  },
}));

mock.module("@releases/lib/embed-entities.js", () => ({
  embedAndUpsertEntities: async ({ onPersisted }: { onPersisted: OnPersisted }) => {
    await onPersisted([]);
  },
}));

mock.module("@releases/lib/embed-changelog-pipeline.js", () => ({
  embedAndUpsertChangelogFile: async () => {
    // no-op
  },
}));

mock.module("../src/lib/embed-config.js", () => ({
  buildEmbedConfig: async () => null,
}));

const { Hono } = await import("hono");
const { workflowsRoutes } = await import("../src/routes/workflows.js");

function mkDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  applyMigrations(sqlite);
  return db;
}

function mkApp(db: ReturnType<typeof mkDb>) {
  const fakeEnv = {
    DB: db,
    RELEASES_INDEX: {},
    ENTITIES_INDEX: {},
    CHANGELOG_CHUNKS_INDEX: {},
  };
  const app = new Hono();
  const v1 = new Hono();
  v1.route("/", workflowsRoutes);
  app.route("/v1", v1);
  return (req: Request) => app.fetch(req, fakeEnv);
}

async function seedReleases(db: ReturnType<typeof mkDb>) {
  await db
    .insert(organizations)
    .values({ id: "org_1", slug: "acme", name: "Acme", category: "cloud" });
  await db.insert(sources).values({
    id: "src_1",
    orgId: "org_1",
    slug: "acme-src",
    name: "Acme Source",
    url: "https://acme.test/changelog",
    type: "feed",
  });
  const now = new Date().toISOString();
  await db.insert(releases).values([
    {
      id: "rel_1",
      sourceId: "src_1",
      title: "v1",
      content: "c1",
      url: "https://a.test/1",
      publishedAt: now,
      fetchedAt: now,
      contentHash: "h1",
    },
    {
      id: "rel_2",
      sourceId: "src_1",
      title: "v2",
      content: "c2",
      url: "https://a.test/2",
      publishedAt: now,
      fetchedAt: now,
      contentHash: "h2",
    },
  ]);
}

// ── POST /v1/workflows/embed-releases ────────────────────────────────────────

describe("POST /v1/workflows/embed-releases", () => {
  it("returns 503 when embed config is missing (mock returns null)", async () => {
    const db = mkDb();
    await seedReleases(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/workflows/embed-releases", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );

    // buildEmbedConfig is mocked to return null → 503
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("embed_unavailable");
  });

  it("returns dryRun=true with remaining count without embedding", async () => {
    const db = mkDb();
    await seedReleases(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/workflows/embed-releases", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dryRun: true }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { dryRun: boolean; remaining: number; processed: number };
    expect(body.dryRun).toBe(true);
    expect(body.processed).toBe(2);
    expect(body.remaining).toBe(2);
  });

  it("returns processed=0 when all releases are already embedded", async () => {
    const db = mkDb();
    await db.insert(organizations).values({ id: "org_x", slug: "x", name: "X", category: "cloud" });
    await db.insert(sources).values({
      id: "src_x",
      orgId: "org_x",
      slug: "x-src",
      name: "X",
      url: "https://x.test",
      type: "feed",
    });
    const now = new Date().toISOString();
    await db.insert(releases).values({
      id: "rel_x",
      sourceId: "src_x",
      title: "v0",
      content: "c0",
      url: "https://x.test/r",
      publishedAt: now,
      fetchedAt: now,
      contentHash: "hx",
      embeddedAt: now, // already embedded
    });

    const fetch = mkApp(db);
    const res = await fetch(
      new Request("https://x.test/v1/workflows/embed-releases", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { processed: number; remaining: number };
    expect(body.processed).toBe(0);
    expect(body.remaining).toBe(0);
  });
});

// ── POST /v1/workflows/embed-entities ────────────────────────────────────────

describe("POST /v1/workflows/embed-entities", () => {
  it("returns 503 when embed config is missing", async () => {
    const db = mkDb();
    await db
      .insert(organizations)
      .values({ id: "org_1", slug: "acme", name: "Acme", category: "cloud" });
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/workflows/embed-entities", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("embed_unavailable");
  });

  it("returns dryRun=true with entity count", async () => {
    const db = mkDb();
    await db.insert(organizations).values([
      { id: "org_1", slug: "acme", name: "Acme", category: "cloud" },
      { id: "org_2", slug: "beta", name: "Beta", category: "ai" },
    ]);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/workflows/embed-entities", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dryRun: true, kind: "org" }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { dryRun: boolean; processed: number; remaining: number };
    expect(body.dryRun).toBe(true);
    expect(body.processed).toBe(2);
    expect(body.remaining).toBe(2);
  });

  it("returns processed=0 when all entities are embedded", async () => {
    const db = mkDb();
    const now = new Date().toISOString();
    await db
      .insert(organizations)
      .values({ id: "org_1", slug: "acme", name: "Acme", category: "cloud", embeddedAt: now });
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/workflows/embed-entities", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "org" }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { processed: number };
    expect(body.processed).toBe(0);
  });
});

// ── POST /v1/workflows/embed-changelogs ──────────────────────────────────────

describe("POST /v1/workflows/embed-changelogs", () => {
  it("returns 404 when sourceSlug does not exist", async () => {
    const db = mkDb();
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/workflows/embed-changelogs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceSlug: "ghost-src" }),
      }),
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });

  it("returns processed=0 when no changelog files exist", async () => {
    const db = mkDb();
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/workflows/embed-changelogs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { processed: number; remaining: number };
    expect(body.processed).toBe(0);
    expect(body.remaining).toBe(0);
  });

  it("returns dryRun=true with file count when files need work", async () => {
    const db = mkDb();
    await db
      .insert(organizations)
      .values({ id: "org_1", slug: "acme", name: "Acme", category: "cloud" });
    await db.insert(sources).values({
      id: "src_1",
      orgId: "org_1",
      slug: "acme-src",
      name: "Acme Source",
      url: "https://acme.test/changelog",
      type: "github",
    });
    const now = new Date().toISOString();
    await db.insert(sourceChangelogFiles).values({
      id: "scf_1",
      sourceId: "src_1",
      path: "CHANGELOG.md",
      filename: "CHANGELOG.md",
      url: "https://github.com/acme/src/blob/main/CHANGELOG.md",
      rawUrl: "https://raw.githubusercontent.com/acme/src/main/CHANGELOG.md",
      content: "# Changelog\n## v1\n- thing",
      contentHash: "abc123",
      bytes: 30,
      fetchedAt: now,
    });
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/workflows/embed-changelogs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dryRun: true }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { dryRun: boolean; processed: number; remaining: number };
    expect(body.dryRun).toBe(true);
    expect(body.processed).toBe(1);
    expect(body.remaining).toBe(1);
  });
});
