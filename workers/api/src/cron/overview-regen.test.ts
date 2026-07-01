/**
 * Tests for overview-regen.ts.
 *
 * Reuses the org/source/release seeding pattern from
 * packages/core-internal/src/overview-eligibility.test.ts — same
 * createTestDb + same insert helpers.
 */

import { test, expect } from "bun:test";
import { eq, and } from "drizzle-orm";
import {
  organizations,
  sources,
  releases,
  knowledgePages,
} from "@buildinternet/releases-core/schema";
import { createTestDb } from "../../../../tests/db-helper";
import type { TextModel } from "@releases/ai-internal/text-model";
import { regenerateOverviewChunk } from "./overview-regen";
import type { OverviewCandidate } from "@releases/core-internal/overview-eligibility";

// ── Fake model ────────────────────────────────────────────────────────────────

function fakeModel(text: string, onCall?: () => void): TextModel {
  return {
    id: "openrouter:test",
    async complete() {
      onCall?.();
      return { text, usage: { input: 1, output: 1, cacheCreate: 0, cacheRead: 0 } };
    },
  };
}

const OUTPUT = "Acme shipped a streaming API and faster cold starts.\n```json\n[]\n```";

// ── Seed helper ───────────────────────────────────────────────────────────────

/**
 * Insert a minimal org + source + N releases.
 * Returns { orgId, orgSlug } so tests can build an OverviewCandidate.
 */
async function seedOrgWithReleases(
  db: ReturnType<typeof createTestDb>["db"],
  opts: { releases: number; orgId?: string; orgSlug?: string },
): Promise<{ orgId: string; orgSlug: string }> {
  const orgId = opts.orgId ?? "org_regen_01";
  const orgSlug = opts.orgSlug ?? "regen-org";
  const srcId = `src_regen_${orgId}`;

  db.insert(organizations)
    .values({
      id: orgId,
      name: "Acme",
      slug: orgSlug,
      discovery: "curated" as const,
      autoGenerateContent: true,
    })
    .run();

  db.insert(sources)
    .values({
      id: srcId,
      name: "Acme Source",
      slug: `acme-source-${orgId}`,
      type: "github" as const,
      url: `https://github.com/acme/repo-${orgId}`,
      orgId,
      discovery: "curated" as const,
      isHidden: false,
      fetchPriority: "normal" as const,
    })
    .run();

  if (opts.releases > 0) {
    const rows = Array.from({ length: opts.releases }, (_, i) => ({
      id: `rel_regen_${orgId}_${i}`,
      sourceId: srcId,
      title: `Release ${i}`,
      content: `body for release ${i}`,
      publishedAt: new Date(Date.now() - i * 86400000).toISOString(),
      fetchedAt: new Date(Date.now() - i * 86400000).toISOString(),
      suppressed: false as const,
    }));
    db.insert(releases).values(rows).run();
  }

  return { orgId, orgSlug };
}

function makeCandidate(
  orgId: string,
  orgSlug: string,
  recentReleaseCount: number,
): OverviewCandidate {
  return {
    orgId,
    orgSlug,
    orgName: "Acme",
    hasOverview: false,
    overviewUpdatedAt: null,
    recentReleaseCount,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("regenerateOverviewChunk writes an overview and reports generated=1", async () => {
  const { db } = createTestDb();
  const { orgId, orgSlug } = await seedOrgWithReleases(db, { releases: 3 });
  const candidates = [makeCandidate(orgId, orgSlug, 3)];

  const res = await regenerateOverviewChunk(db as any, fakeModel(OUTPUT), candidates);
  expect(res).toEqual({ generated: 1, skipped: 0, failed: 0, failedSlugs: [] });

  // Read back: a knowledge_pages row now exists for this org.
  const rows = await db
    .select()
    .from(knowledgePages)
    .where(and(eq(knowledgePages.scope, "org"), eq(knowledgePages.orgId, orgId)));
  expect(rows.length).toBe(1);
  expect(rows[0]!.content).toBeTruthy();
});

test("dryRun does not write but still counts generated", async () => {
  const { db } = createTestDb();
  const { orgId, orgSlug } = await seedOrgWithReleases(db, {
    releases: 2,
    orgId: "org_regen_02",
    orgSlug: "regen-org-02",
  });
  const candidates = [makeCandidate(orgId, orgSlug, 2)];

  const res = await regenerateOverviewChunk(db as any, fakeModel(OUTPUT), candidates, {
    dryRun: true,
  });
  expect(res.generated).toBe(1);

  // No knowledge_pages row should exist.
  const rows = await db
    .select()
    .from(knowledgePages)
    .where(and(eq(knowledgePages.scope, "org"), eq(knowledgePages.orgId, orgId)));
  expect(rows.length).toBe(0);
});

test("an org with no selectable releases is skipped", async () => {
  const { db } = createTestDb();
  const { orgId, orgSlug } = await seedOrgWithReleases(db, {
    releases: 0,
    orgId: "org_regen_03",
    orgSlug: "regen-org-03",
  });
  const candidates = [makeCandidate(orgId, orgSlug, 0)];

  const res = await regenerateOverviewChunk(db as any, fakeModel(OUTPUT), candidates);
  expect(res).toEqual({ generated: 0, skipped: 1, failed: 0, failedSlugs: [] });
});

test("a model error isolates to failed and reports the slug, without throwing", async () => {
  const { db } = createTestDb();
  const { orgId, orgSlug } = await seedOrgWithReleases(db, {
    releases: 1,
    orgId: "org_regen_04",
    orgSlug: "regen-org-04",
  });
  const candidates = [makeCandidate(orgId, orgSlug, 1)];

  let calls = 0;
  const throwing: TextModel = {
    id: "openrouter:test",
    async complete() {
      calls++;
      throw new Error("boom");
    },
  };

  const res = await regenerateOverviewChunk(db as any, throwing, candidates, {
    retryBackoffMs: 0,
  });
  expect(res).toEqual({ generated: 0, skipped: 0, failed: 1, failedSlugs: ["regen-org-04"] });
  // Default is initial attempt + one retry: the failing model is called twice.
  expect(calls).toBe(2);
});

test("a transient error is retried and the second attempt succeeds", async () => {
  const { db } = createTestDb();
  const { orgId, orgSlug } = await seedOrgWithReleases(db, {
    releases: 2,
    orgId: "org_regen_05",
    orgSlug: "regen-org-05",
  });
  const candidates = [makeCandidate(orgId, orgSlug, 2)];

  let calls = 0;
  const flaky: TextModel = {
    id: "openrouter:test",
    async complete() {
      calls++;
      if (calls === 1) {
        throw new Error("The operation was aborted due to timeout");
      }
      return { text: OUTPUT, usage: { input: 1, output: 1, cacheCreate: 0, cacheRead: 0 } };
    },
  };

  const res = await regenerateOverviewChunk(db as any, flaky, candidates, { retryBackoffMs: 0 });
  expect(res).toEqual({ generated: 1, skipped: 0, failed: 0, failedSlugs: [] });
  // First generateOverview attempt threw; the recovery proves the retry fired.
  // (generateOverview may itself re-call the model for a corrective pass, so the
  // exact count is >= 2 rather than pinned.)
  expect(calls).toBeGreaterThanOrEqual(2);
});
