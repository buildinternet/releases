/**
 * Read-path surfacing of `releases.breaking` / `releases.migration_notes`
 * (#1710, data landed in #1703/#1696). Pins the split the plan mandates:
 *
 * - Detail (`GET /v1/releases/:id`) carries BOTH `breaking` and
 *   `migrationNotes`.
 * - List paths (latest feed, org feed) carry `breaking` ONLY — migration
 *   notes can be long, so they stay detail-route-only.
 * - An unclassified row surfaces the stored `"unknown"` fail-open default;
 *   a NULL `migration_notes` is ABSENT from the JSON (not `null`).
 * - A NULL `breaking` (only possible on rows predating the column — the
 *   NOT NULL DEFAULT 'unknown' migration backfills real DBs) maps to the
 *   field being absent; the mapper never invents a value.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { createTestDb as createTestDatabase, type TestDatabase } from "../../../tests/db-helper";
import { sourceRoutes } from "../src/routes/sources.js";
import { orgRoutes } from "../src/routes/orgs.js";
import { createTestApp } from "./setup";
import {
  getLatestReleasesAcross,
  mapLatestRowToReleaseItem,
  type LatestReleaseRow,
} from "../src/queries/releases.js";

let testDb: TestDatabase;

beforeEach(async () => {
  testDb = createTestDatabase();
  await testDb.db
    .insert(organizations)
    .values({ id: "org_a", slug: "acme", name: "Acme", category: "cloud" });
  await testDb.db.insert(sources).values({
    id: "src_a",
    slug: "acme-feed",
    name: "Acme Feed",
    type: "feed",
    url: "https://acme.test/feed",
    orgId: "org_a",
  });
  await testDb.db.insert(releases).values([
    {
      id: "rel_major",
      sourceId: "src_a",
      title: "Acme 2.0",
      version: "2.0.0",
      content: "Removes the legacy config format.",
      url: "https://acme.test/2.0.0",
      publishedAt: "2026-06-01T00:00:00Z",
      breaking: "major",
      migrationNotes: "Rename `legacy_config` to `config` before upgrading.",
    },
    {
      id: "rel_plain",
      sourceId: "src_a",
      title: "Acme 2.0.1",
      version: "2.0.1",
      content: "Bug fixes.",
      url: "https://acme.test/2.0.1",
      publishedAt: "2026-06-02T00:00:00Z",
      // No `breaking` / `migrationNotes` — lands the schema defaults:
      // breaking 'unknown', migration_notes NULL.
    },
  ]);
});

describe("GET /v1/releases/:id — breaking + migrationNotes (detail carries both)", () => {
  it("surfaces breaking and migrationNotes on a classified release", async () => {
    const app = createTestApp(testDb.db, sourceRoutes);
    const res = await app(new Request("http://x/v1/releases/rel_major"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { breaking?: string; migrationNotes?: string | null };
    expect(body.breaking).toBe("major");
    expect(body.migrationNotes).toBe("Rename `legacy_config` to `config` before upgrading.");
  });

  it("surfaces the 'unknown' fail-open default and OMITS null migrationNotes", async () => {
    const app = createTestApp(testDb.db, sourceRoutes);
    const res = await app(new Request("http://x/v1/releases/rel_plain"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // Unclassified rows store 'unknown' (never a false verdict) — surfaced
    // verbatim; the web renders nothing for it.
    expect(body.breaking).toBe("unknown");
    // NULL migration_notes → field absent from the JSON, not `null`.
    expect("migrationNotes" in body).toBe(false);
  });
});

describe("latest feed — breaking only, never migrationNotes", () => {
  it("carries breaking on the item and never migrationNotes", async () => {
    const rows = await getLatestReleasesAcross(testDb.db as unknown as D1Database, { limit: 50 });
    const items = rows.map((r) => mapLatestRowToReleaseItem(r, ""));
    const major = items.find((i) => i.id === "rel_major")!;
    const plain = items.find((i) => i.id === "rel_plain")!;
    expect(major.breaking).toBe("major");
    expect(plain.breaking).toBe("unknown");
    for (const item of items) {
      expect("migrationNotes" in item).toBe(false);
    }
  });

  it("maps a NULL breaking row (pre-column) to an absent field — never invents a value", () => {
    const row: LatestReleaseRow = {
      id: "rel_legacy",
      version: null,
      title: "Legacy",
      summary: null,
      title_generated: null,
      title_short: null,
      breaking: null,
      published_at: null,
      url: null,
      media: null,
      source_slug: "acme-feed",
      source_name: "Acme Feed",
      source_type: "feed",
      org_slug: "acme",
      org_name: "Acme",
      org_avatar_url: null,
      org_github_handle: null,
      product_slug: null,
      product_name: null,
      type: "feature",
      coverage_count: 0,
      content_chars: null,
      content_tokens: null,
    };
    const item = mapLatestRowToReleaseItem(row, "");
    expect(item.breaking).toBeUndefined();
  });
});

describe("GET /v1/orgs/:slug/releases — org feed carries breaking on items", () => {
  it("surfaces breaking on each item and never migrationNotes", async () => {
    const app = createTestApp(testDb.db, orgRoutes);
    const res = await app(new Request("http://x/v1/orgs/acme/releases"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      releases: Array<Record<string, unknown> & { id: string; breaking?: string }>;
    };
    const major = body.releases.find((r) => r.id === "rel_major")!;
    const plain = body.releases.find((r) => r.id === "rel_plain")!;
    expect(major.breaking).toBe("major");
    expect(plain.breaking).toBe("unknown");
    for (const item of body.releases) {
      expect("migrationNotes" in item).toBe(false);
    }
  });
});
