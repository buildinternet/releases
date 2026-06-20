/**
 * `GET /v1/whats-changed` (#1697) — upgrade-intelligence Phase 1 route smoke
 * test. Seeds a source + versioned releases, then exercises: a resolved range
 * (from-exclusive/to-inclusive ordering + breaking flow-through), the unknown
 * package answer (HTTP 200, not 404), and bad-request validation.
 */
import { describe, it, expect } from "bun:test";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { computeVersionSort } from "@buildinternet/releases-core/version-sort";
import type { BreakingLevel } from "@buildinternet/releases-core/breaking";
import { whatsChangedRoutes } from "../src/routes/whats-changed.js";
import { createTestDb as mkDb, createTestApp, type TestDb } from "./setup";
import type { WhatsChangedResponse } from "@buildinternet/releases-api-types";

const mkApp = (db: TestDb) => createTestApp(db, [whatsChangedRoutes]);

function relRow(
  id: string,
  version: string,
  publishedAt: string,
  breaking: BreakingLevel = "unknown",
) {
  return {
    id,
    sourceId: "src_acme",
    version,
    versionSort: computeVersionSort(version),
    title: `Acme ${version}`,
    titleGenerated: `Acme ${version} release`,
    content: `notes for ${version}`,
    summary: `summary for ${version}`,
    breaking,
    publishedAt,
    url: `https://github.com/acme/sdk/releases/tag/${version}`,
  };
}

async function seed(db: TestDb) {
  await db
    .insert(organizations)
    .values([{ id: "org_acme", slug: "acme", name: "Acme", category: "developer-tools" }]);
  await db.insert(sources).values([
    {
      id: "src_acme",
      slug: "acme-sdk",
      name: "Acme SDK",
      type: "github",
      url: "https://github.com/acme/sdk",
      orgId: "org_acme",
    },
  ]);
  await db
    .insert(releases)
    .values([
      relRow("rel_100", "1.0.0", "2026-01-01T00:00:00Z"),
      relRow("rel_110", "1.1.0", "2026-02-01T00:00:00Z"),
      relRow("rel_120", "1.2.0", "2026-03-01T00:00:00Z"),
      relRow("rel_200", "2.0.0", "2026-04-01T00:00:00Z", "major"),
    ]);
}

const call = (app: ReturnType<typeof mkApp>, qs: string) =>
  app(new Request(`https://api.test/v1/whats-changed?${qs}`));

describe("GET /v1/whats-changed", () => {
  it("resolves a catalog source by slug and returns the (from, to] range, ascending", async () => {
    const db = mkDb();
    await seed(db);
    const res = await call(mkApp(db), "package=acme-sdk&from=1.0.0&to=2.0.0");
    expect(res.status).toBe(200);
    const body = (await res.json()) as WhatsChangedResponse;
    expect(body.status).toBe("resolved");
    expect(body.source?.sourceSlug).toBe("acme-sdk");
    expect(body.entries.map((e) => e.version)).toEqual(["1.1.0", "1.2.0", "2.0.0"]); // from exclusive, to inclusive
  });

  it("flows the breaking verdict (#1696) through to the entries", async () => {
    const db = mkDb();
    await seed(db);
    const res = await call(mkApp(db), "package=acme-sdk&from=1.2.0&to=2.0.0");
    const body = (await res.json()) as WhatsChangedResponse;
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].version).toBe("2.0.0");
    expect(body.entries[0].breaking).toBe("major");
    // AI title is preferred over the raw title.
    expect(body.entries[0].title).toBe("Acme 2.0.0 release");
  });

  it("resolves a GitHub owner/repo coordinate read-only (no materialize)", async () => {
    const db = mkDb();
    await seed(db);
    const res = await call(mkApp(db), "package=acme/sdk&ecosystem=github&from=1.0.0&to=1.1.0");
    const body = (await res.json()) as WhatsChangedResponse;
    expect(body.status).toBe("resolved");
    expect(body.entries.map((e) => e.version)).toEqual(["1.1.0"]);
  });

  it("returns status:unknown with HTTP 200 (not 404) for an unresolvable package", async () => {
    const db = mkDb();
    await seed(db);
    const res = await call(mkApp(db), "package=not-a-real-package&from=1.0.0&to=2.0.0");
    expect(res.status).toBe(200);
    const body = (await res.json()) as WhatsChangedResponse;
    expect(body.status).toBe("unknown");
    expect(body.source).toBeNull();
    expect(body.entries).toEqual([]);
  });

  it("400s when from/to are missing", async () => {
    const db = mkDb();
    await seed(db);
    const res = await call(mkApp(db), "package=acme-sdk");
    expect(res.status).toBe(400);
  });
});
