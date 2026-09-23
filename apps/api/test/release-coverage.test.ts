/**
 * GET /v1/releases/:id/coverage — verifies each coverage row carries its
 * counterpart release's display fields (`sibling`), so the web "also covered
 * by" rail renders a cluster without a per-sibling `GET /releases/:id`.
 *
 * Also pins the precursor fix: on a canonical release the rollup siblings are
 * coverage-side rows, which `releases_visible` (and thus `GET /releases/:id`)
 * hides — the old per-sibling fan-out 404'd them and rendered nothing. The
 * cluster view sources them from `releases` directly, so they surface here.
 */
import { describe, it, expect } from "bun:test";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { releaseCoverage } from "@releases/core-internal/schema-coverage.js";
import { releaseRoutes } from "../src/routes/releases.js";
import { createTestDb as mkDb, createTestApp } from "./setup";

const mkApp = (db: ReturnType<typeof mkDb>) => createTestApp(db, [releaseRoutes]);

async function seed(db: ReturnType<typeof mkDb>) {
  await db
    .insert(organizations)
    .values([{ id: "org_acme", slug: "acme", name: "Acme", category: "cloud" }]);
  await db.insert(sources).values([
    {
      id: "src_blog",
      slug: "acme-blog",
      name: "Acme Blog",
      type: "feed",
      url: "https://acme.example/blog",
      orgId: "org_acme",
    },
    {
      id: "src_changelog",
      slug: "acme-changelog",
      name: "Acme Changelog",
      type: "github",
      url: "https://github.com/acme/acme",
      orgId: "org_acme",
    },
  ]);
  await db.insert(releases).values([
    {
      id: "rel_canon",
      sourceId: "src_blog",
      title: "Acme 2.0 launch post",
      content: "We launched Acme 2.0.",
      version: null,
      url: "https://acme.example/blog/acme-2",
      publishedAt: "2026-05-10T12:00:00.000Z",
      media: JSON.stringify([
        { type: "image", url: "https://cdn.example.com/launch.png", alt: "Launch hero" },
      ]),
    },
    {
      id: "rel_cov_changelog",
      sourceId: "src_changelog",
      title: "v2.0.0",
      content: "Changelog for 2.0.0.",
      version: "2.0.0",
      url: "https://github.com/acme/acme/releases/tag/v2.0.0",
      publishedAt: "2026-05-10T12:30:00.000Z",
    },
    {
      id: "rel_cov_suppressed",
      sourceId: "src_changelog",
      title: "v2.0.0 (dupe)",
      content: "Duplicate row.",
      version: "2.0.0",
      url: "https://github.com/acme/acme/releases/tag/v2.0.0-dupe",
      publishedAt: "2026-05-10T12:31:00.000Z",
      suppressed: true,
    },
    {
      id: "rel_solo",
      sourceId: "src_blog",
      title: "Unrelated post",
      content: "Nothing to see.",
      url: "https://acme.example/blog/solo",
      publishedAt: "2026-05-01T09:00:00.000Z",
    },
  ]);
  await db.insert(releaseCoverage).values([
    {
      coverageId: "rel_cov_changelog",
      canonicalId: "rel_canon",
      reason: null,
      decidedBy: "human:cli",
      decidedAt: "2026-05-10T13:00:00.000Z",
    },
    {
      coverageId: "rel_cov_suppressed",
      canonicalId: "rel_canon",
      reason: null,
      decidedBy: "human:cli",
      decidedAt: "2026-05-10T13:00:00.000Z",
    },
  ]);
}

const get = (fetch: ReturnType<typeof mkApp>, id: string) =>
  fetch(new Request(`http://t/v1/releases/${id}/coverage`));

describe("GET /v1/releases/:id/coverage — sibling enrichment", () => {
  it("canonical role returns each rollup's display fields inline", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await get(fetch, "rel_canon");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.role).toBe("canonical");
    expect(body.covers).toHaveLength(2);

    const live = body.covers.find((r: any) => r.coverageId === "rel_cov_changelog");
    expect(live.sibling).toMatchObject({
      id: "rel_cov_changelog",
      version: "2.0.0",
      title: "v2.0.0",
      sourceName: "Acme Changelog",
      org: { slug: "acme", name: "Acme" },
    });

    // A suppressed rollup is still listed in the join table, but its display
    // fields are withheld (sibling = null) so the UI can skip it.
    const dupe = body.covers.find((r: any) => r.coverageId === "rel_cov_suppressed");
    expect(dupe.sibling).toBeNull();
  });

  it("coverage role returns the canonical's display fields inline", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await get(fetch, "rel_cov_changelog");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.role).toBe("coverage");
    expect(body.canonical.canonicalId).toBe("rel_canon");
    expect(body.canonical.sibling).toMatchObject({
      id: "rel_canon",
      title: "Acme 2.0 launch post",
      sourceName: "Acme Blog",
      org: { slug: "acme", name: "Acme" },
    });
  });

  it("surfaces the canonical sibling thumbnail from its first image media", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await get(fetch, "rel_cov_changelog");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      role: string;
      canonical: { sibling: { thumbnail: { url: string; alt?: string } | null } | null };
    };
    expect(body.role).toBe("coverage");
    expect(body.canonical.sibling?.thumbnail).toEqual({
      url: "https://cdn.example.com/launch.png",
      alt: "Launch hero",
    });
  });

  it("standalone role returns no siblings", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await get(fetch, "rel_solo");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.role).toBe("standalone");
    expect(body.canonical).toBeNull();
    expect(body.covers).toHaveLength(0);
  });
});
