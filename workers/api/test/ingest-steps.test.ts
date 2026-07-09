/**
 * Unit tests for the shared post-insert step helpers (lib/ingest-steps.ts,
 * #1946 phase 3). Both the poll path and the firecrawl webhook path delegate
 * their post-insert side-effect chain here, so locking the emitted `step.do`
 * names + order + gating in one place is what keeps the two workflows from
 * drifting again (the drift these helpers close was fixed in #1955).
 *
 * The `step.do` names are load-bearing: CF Workflows matches completed steps by
 * name on replay, so a rename would change what an in-flight instance replays.
 *
 * A step-spy records names in order and runs each body. Bodies are near-no-ops:
 * `generateContentForReleases` short-circuits on an empty candidate SELECT
 * (in-memory sqlite with no matching rows), `embedReleasesForSource`
 * short-circuits without a VOYAGE key, and `invalidateLatestCache`
 * short-circuits without a LATEST_CACHE binding — so the assertions are purely
 * on ordering + gating, not side-effects.
 */

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations, ensureBatchShim } from "../../../tests/db-helper";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import type { Source } from "@buildinternet/releases-core/schema";
import type { WorkflowStep } from "cloudflare:workers";
import type { FetchOneEnv } from "../src/cron/poll-fetch.js";
import { runContentAndEmbedSteps, runInvalidateLatestCacheStep } from "../src/lib/ingest-steps.js";

function mkDb() {
  const sqlite = new Database(":memory:");
  const db = ensureBatchShim(drizzle(sqlite));
  applyMigrations(sqlite);
  db.insert(organizations)
    .values({ id: "org_is", slug: "acme", name: "Acme", category: "productivity" })
    .run();
  db.insert(sources)
    .values({
      id: "src_is",
      orgId: "org_is",
      slug: "acme-changelog",
      name: "Acme Changelog",
      type: "scrape",
      url: "https://acme.example/changelog",
    })
    .run();
  return db;
}

const SOURCE: Source = {
  id: "src_is",
  slug: "acme-changelog",
  isHidden: false,
} as unknown as Source;

/** Records `step.do` names in order and runs each body (handles the 2- and
 *  3-arg `step.do(name, fn)` / `step.do(name, config, fn)` shapes). */
function mkStepSpy() {
  const names: string[] = [];
  const step = {
    do: async (name: string, a: unknown, b?: unknown) => {
      names.push(name);
      const fn = (typeof a === "function" ? a : b) as () => Promise<unknown>;
      return await fn();
    },
    sleep: async () => {},
  } as unknown as WorkflowStep;
  return { names, step };
}

// RELEASES_INDEX truthy so embed-releases is REACHED (with no VOYAGE key the
// embed helper short-circuits without embedding). No LATEST_CACHE → invalidate
// is a logged no-op, but the step still records so we can assert it fires.
function mkCtx(db: ReturnType<typeof mkDb>, insertedIds: string[]) {
  const env = { RELEASES_INDEX: {} } as unknown as Parameters<
    typeof runContentAndEmbedSteps
  >[1]["env"];
  return {
    db,
    env,
    source: SOURCE,
    insertedIds,
    fetchEnv: {} as FetchOneEnv,
  };
}

describe("runContentAndEmbedSteps", () => {
  it("emits generate-content before embed-releases when rows were inserted", async () => {
    const db = mkDb();
    const { names, step } = mkStepSpy();
    await runContentAndEmbedSteps(step, mkCtx(db, ["rel_1"]));

    expect(names).toEqual(["generate-content", "embed-releases"]);
  });

  it("skips mirror-og-images when MEDIA is absent (no binding, no fetch attempted)", async () => {
    const db = mkDb();
    const { names, step } = mkStepSpy();
    await runContentAndEmbedSteps(step, mkCtx(db, ["rel_1"]));

    expect(names).not.toContain("mirror-og-images");
  });

  it("emits mirror-og-images between generate-content and embed-releases when MEDIA is bound (#2066)", async () => {
    const db = mkDb();
    const { names, step } = mkStepSpy();
    const ctx = mkCtx(db, ["rel_1"]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only env augmentation
    (ctx.env as any).MEDIA = { put: async () => ({}) };

    await runContentAndEmbedSteps(step, ctx);

    expect(names).toEqual(["generate-content", "mirror-og-images", "embed-releases"]);
  });

  it("skips embed-releases when RELEASES_INDEX is absent", async () => {
    const db = mkDb();
    const { names, step } = mkStepSpy();
    const ctx = mkCtx(db, ["rel_1"]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (ctx.env as any).RELEASES_INDEX;
    await runContentAndEmbedSteps(step, ctx);

    expect(names).toEqual(["generate-content"]);
  });

  it("emits nothing when no rows were inserted", async () => {
    const db = mkDb();
    const { names, step } = mkStepSpy();
    await runContentAndEmbedSteps(step, mkCtx(db, []));

    expect(names).toEqual([]);
  });

  it("invokes onStep with each emitted step name", async () => {
    const db = mkDb();
    const { step } = mkStepSpy();
    const tracked: string[] = [];
    await runContentAndEmbedSteps(step, mkCtx(db, ["rel_1"]), (n) => tracked.push(n));

    expect(tracked).toEqual(["generate-content", "embed-releases"]);
  });
});

describe("runInvalidateLatestCacheStep", () => {
  it("emits invalidate-latest-cache when rows were inserted", async () => {
    const { names, step } = mkStepSpy();
    const onStep: string[] = [];
    await runInvalidateLatestCacheStep(step, {} as never, SOURCE, 3, (n) => onStep.push(n));

    expect(names).toEqual(["invalidate-latest-cache"]);
    expect(onStep).toEqual(["invalidate-latest-cache"]);
  });

  it("no-ops when nothing was inserted", async () => {
    const { names, step } = mkStepSpy();
    await runInvalidateLatestCacheStep(step, {} as never, SOURCE, 0);

    expect(names).toEqual([]);
  });
});
