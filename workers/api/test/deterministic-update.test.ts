/**
 * DeterministicUpdateWorkflow — direct-D1 persistence + post-insert chain
 * (#1946 phase 4, task 8).
 *
 * `scrapeFetch` is mocked at module scope (this file's own `bun test`
 * process — see AGENTS.md's note on `workers/api` running isolated from the
 * rest of the suite specifically so a `mock.module` here can't leak into
 * other packages) so the test drives the workflow's step orchestration
 * without a real scrape/extract. It exercises:
 *   (a) fetch steps are still named `fetch:<source>`;
 *   (b) a result carrying `insertedIds` triggers namespaced
 *       `<source>:generate-content` + `<source>:invalidate-latest-cache`
 *       steps (embed is skipped — no RELEASES_INDEX truthy binding in env);
 *   (c) a throwing `generate-content` step doesn't fail the run — the run
 *       still reaches `session:complete`.
 */

import { describe, it, expect, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations, ensureBatchShim } from "../../../tests/db-helper";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import type { WorkflowStep } from "cloudflare:workers";

// Module-scope mock: replaces the real network/extraction scrapeFetch with a
// per-source-identifier response table the test controls. Declared before the
// workflow import so the workflow module resolves the mocked version.
const scrapeResponses = new Map<string, string>();
mock.module("@releases/adapters/scrape-fetch", () => ({
  scrapeFetch: async (_env: unknown, source: string) => {
    const response = scrapeResponses.get(source);
    if (!response) throw new Error(`no mocked response for ${source}`);
    return response;
  },
}));

const { DeterministicUpdateWorkflow } = await import("../src/workflows/deterministic-update.js");

function mkDb() {
  const sqlite = new Database(":memory:");
  const db = ensureBatchShim(drizzle(sqlite));
  applyMigrations(sqlite);
  db.insert(organizations)
    .values({ id: "org_du", slug: "acme", name: "Acme", category: "productivity" })
    .run();
  db.insert(sources)
    .values({
      id: "src_du",
      orgId: "org_du",
      slug: "acme-changelog",
      name: "Acme Changelog",
      type: "scrape",
      url: "https://acme.example/changelog",
    })
    .run();
  return db;
}

/** Records `step.do` names in order and runs each body, unless `throwOn`
 *  matches the step name (post-namespacing) — used to simulate a failing
 *  post-insert step without touching the real AI call. */
function mkStepSpy(opts: { throwOn?: (name: string) => boolean } = {}) {
  const names: string[] = [];
  const step = {
    do: async (name: string, a: unknown, b?: unknown) => {
      names.push(name);
      if (opts.throwOn?.(name)) throw new Error(`simulated failure: ${name}`);
      const fn = (typeof a === "function" ? a : b) as () => Promise<unknown>;
      return await fn();
    },
    sleep: async () => {},
    sleepUntil: async () => {},
    waitForEvent: async () => ({}) as never,
  } as unknown as WorkflowStep;
  return { names, step };
}

function mkEnv(db: ReturnType<typeof mkDb>): unknown {
  return {
    _drizzleOverride: db,
    // buildScrapeEnv() short-circuit requires these truthy — cheap dummies.
    CLOUDFLARE_ACCOUNT_ID: { get: async () => "acct" },
    CLOUDFLARE_API_TOKEN: { get: async () => "tok" },
    ANTHROPIC_API_KEY: { get: async () => "key" },
    RELEASES_API_KEY: { get: async () => "relk" },
    API_SELF: { fetch: async () => new Response("{}") },
    // Falsy so embed-releases is skipped (no VOYAGE key needed either way).
    RELEASES_INDEX: undefined,
    RELEASE_HUB: {} as unknown,
  };
}

describe("DeterministicUpdateWorkflow — direct-D1 persist + post-insert chain", () => {
  it("names fetch steps fetch:<source> and skips post-insert when nothing inserted", async () => {
    const db = mkDb();
    scrapeResponses.set(
      "acme-changelog",
      JSON.stringify({ fetched: true, status: "no_change", releasesFound: 0, releasesInserted: 0 }),
    );
    const { names, step } = mkStepSpy();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wf = new (DeterministicUpdateWorkflow as any)({}, mkEnv(db));

    await wf.run(
      {
        payload: {
          sessionId: "sess_1",
          company: "acme",
          sourceIdentifiers: ["acme-changelog"],
        },
      },
      step,
    );

    expect(names).toContain("fetch:acme-changelog");
    expect(names.some((n) => n.includes("generate-content"))).toBe(false);
    expect(names.some((n) => n.includes("invalidate-latest-cache"))).toBe(false);
  });

  it("runs namespaced generate-content + invalidate-latest-cache when insertedIds are present", async () => {
    const db = mkDb();
    scrapeResponses.set(
      "acme-changelog",
      JSON.stringify({
        fetched: true,
        status: "success",
        releasesFound: 1,
        releasesInserted: 1,
        insertedIds: ["rel_1"],
        source: "acme-changelog",
      }),
    );
    const { names, step } = mkStepSpy();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wf = new (DeterministicUpdateWorkflow as any)({}, mkEnv(db));

    await wf.run(
      {
        payload: {
          sessionId: "sess_2",
          company: "acme",
          sourceIdentifiers: ["acme-changelog"],
        },
      },
      step,
    );

    expect(names).toContain("fetch:acme-changelog");
    // Namespaced under the source identifier scrapeFetch reported (source.slug).
    expect(names).toContain("acme-changelog:generate-content");
    expect(names).toContain("acme-changelog:invalidate-latest-cache");
    // No RELEASES_INDEX binding → embed is skipped even though rows were inserted.
    expect(names.some((n) => n.includes("embed-releases"))).toBe(false);
  });

  it("does not fail the run when generate-content throws", async () => {
    const db = mkDb();
    scrapeResponses.set(
      "acme-changelog",
      JSON.stringify({
        fetched: true,
        status: "success",
        releasesFound: 1,
        releasesInserted: 1,
        insertedIds: ["rel_2"],
        source: "acme-changelog",
      }),
    );
    const statusEvents: Record<string, unknown>[] = [];
    const env = mkEnv(db) as Record<string, unknown>;
    // Minimal STATUS_HUB fake so we can assert session:complete still fires
    // despite the simulated post-insert failure.
    env.STATUS_HUB = {
      idFromName: () => "global",
      get: () => ({
        fetch: async (req: Request) => {
          statusEvents.push(JSON.parse(await req.text()));
          return new Response("{}");
        },
      }),
    };

    const { names, step } = mkStepSpy({
      throwOn: (name) => name.endsWith(":generate-content"),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wf = new (DeterministicUpdateWorkflow as any)({}, env);

    await wf.run(
      {
        payload: {
          sessionId: "sess_3",
          company: "acme",
          sourceIdentifiers: ["acme-changelog"],
        },
      },
      step,
    );

    expect(names).toContain("acme-changelog:generate-content");
    // invalidate-latest-cache never runs because the try/catch around the
    // whole per-source post-insert block aborts after the throw — but the
    // overall run still completes successfully (not session:error).
    const complete = statusEvents.find((e) => e.type === "session:complete");
    expect(complete).toBeDefined();
    expect(statusEvents.some((e) => e.type === "session:error")).toBe(false);
  });
});
