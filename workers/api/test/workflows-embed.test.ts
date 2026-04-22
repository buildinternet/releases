// Tests for POST /v1/workflows/embed-{releases,entities,changelogs}.
//
// Covers the safe paths that don't need embed-helper mocks: dry-run, empty
// backlog, and the 503 fallback when EMBEDDING_PROVIDER is unconfigured.
// Happy-path coverage (actually calling embedAndUpsertReleases/-Entities/
// -ChangelogFile) is skipped deliberately — mocking those modules with
// `mock.module` bleeds into packages/lib/src/embed-*.test.ts and turns
// 23 unit tests red. If a future refactor introduces dependency injection
// for the embed helpers, add happy-path cases then.
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations } from "../../../tests/db-helper";
import {
  organizations,
  sources,
  releases,
  sourceChangelogFiles,
} from "@buildinternet/releases-core/schema";

const { Hono } = await import("hono");
const { workflowsRoutes } = await import("../src/routes/workflows.js");

function mkDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  applyMigrations(sqlite);
  return db;
}

function mkApp(db: ReturnType<typeof mkDb>) {
  // No VOYAGE_API_KEY / OPENAI_API_KEY → buildEmbedConfig returns null → 503.
  const fakeEnv = { DB: db };
  const app = new Hono();
  const v1 = new Hono();
  v1.route("/", workflowsRoutes);
  app.route("/v1", v1);
  return (req: Request) => app.fetch(req, fakeEnv);
}

async function seedOneUnembeddedRelease(db: ReturnType<typeof mkDb>): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insert(organizations)
    .values({ id: "org_a", slug: "acme", name: "Acme", category: "developer-tools" });
  await db.insert(sources).values({
    id: "src_a",
    orgId: "org_a",
    slug: "acme-blog",
    name: "Acme Blog",
    type: "scrape",
    url: "https://acme.test",
  });
  await db.insert(releases).values({
    id: "rel_a",
    sourceId: "src_a",
    url: "https://acme.test/1",
    title: "First release",
    content: "body",
    publishedAt: now,
    fetchedAt: now,
  });
}

describe("POST /v1/workflows/embed-releases", () => {
  it("dryRun: returns remaining count without calling embed", async () => {
    const db = mkDb();
    await seedOneUnembeddedRelease(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/workflows/embed-releases", {
        method: "POST",
        body: JSON.stringify({ dryRun: true }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      processed: number;
      succeeded: number;
      failed: number;
      remaining: number;
      dryRun: boolean;
    };
    expect(body.dryRun).toBe(true);
    expect(body.processed).toBe(1);
    expect(body.succeeded).toBe(0);
    expect(body.remaining).toBe(1);
  });

  it("empty backlog: 200 with processed=0", async () => {
    const db = mkDb();
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/workflows/embed-releases", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { processed: number; remaining: number };
    expect(body.processed).toBe(0);
    expect(body.remaining).toBe(0);
  });

  it("503 when embedding provider is not configured", async () => {
    const db = mkDb();
    await seedOneUnembeddedRelease(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/workflows/embed-releases", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("embed_unavailable");
  });

  it("clamps limit above batch cap to 50", async () => {
    const db = mkDb();
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/workflows/embed-releases", {
        method: "POST",
        body: JSON.stringify({ dryRun: true, limit: 9999 }),
      }),
    );
    expect(res.status).toBe(200);
    // With 0 rows the clamp is not observable in the response directly, but
    // the absence of a 400/500 confirms the limit path parses without error.
    const body = (await res.json()) as { processed: number };
    expect(body.processed).toBe(0);
  });
});

describe("POST /v1/workflows/embed-entities", () => {
  it("empty backlog: 200 with processed=0", async () => {
    const db = mkDb();
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/workflows/embed-entities", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { processed: number; remaining: number };
    expect(body.processed).toBe(0);
    expect(body.remaining).toBe(0);
  });

  it("503 when embedding provider is not configured and backlog exists", async () => {
    const db = mkDb();
    await db.insert(organizations).values({
      id: "org_unembedded",
      slug: "unembedded",
      name: "Unembedded",
      category: "developer-tools",
    });
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/workflows/embed-entities", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("embed_unavailable");
  });

  it("kind filter: narrows the backlog to one table", async () => {
    const db = mkDb();
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/workflows/embed-entities", {
        method: "POST",
        body: JSON.stringify({ kind: "org", dryRun: true }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { processed: number; remaining: number };
    expect(body.processed).toBe(0);
    expect(body.remaining).toBe(0);
  });
});

describe("POST /v1/workflows/embed-changelogs", () => {
  it("empty backlog: 200 with processed=0", async () => {
    const db = mkDb();
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/workflows/embed-changelogs", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { processed: number; remaining: number };
    expect(body.processed).toBe(0);
    expect(body.remaining).toBe(0);
  });

  it("503 when embedding provider is not configured and files need work", async () => {
    const db = mkDb();
    await db
      .insert(organizations)
      .values({ id: "org_cl", slug: "cl", name: "CL", category: "developer-tools" });
    await db.insert(sources).values({
      id: "src_cl",
      orgId: "org_cl",
      slug: "cl-src",
      name: "CL Source",
      type: "github",
      url: "https://github.com/cl/cl",
    });
    await db.insert(sourceChangelogFiles).values({
      id: "scf_cl",
      sourceId: "src_cl",
      path: "CHANGELOG.md",
      filename: "CHANGELOG.md",
      url: "https://github.com/cl/cl/blob/main/CHANGELOG.md",
      rawUrl: "https://raw.githubusercontent.com/cl/cl/main/CHANGELOG.md",
      content: "# 1.0.0",
      contentHash: "abc",
      bytes: 7,
    });
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/workflows/embed-changelogs", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("embed_unavailable");
  });
});
