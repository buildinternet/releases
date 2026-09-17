/**
 * POST /v1/sources/:id/fetch must force-arm the SourceActor (#2286) so a
 * manual fetch does not leave managed:false / nextAlarmAt:null.
 */

import { describe, it, expect } from "bun:test";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import { sourceRoutes } from "../src/routes/sources.js";
import { createTestDb, createTestApp } from "./setup";

const statusHubStub = {
  idFromName: () => "stub-id",
  get: () => ({
    fetch: async () => new Response("ok", { status: 200 }),
  }),
};

describe("POST /v1/sources/:id/fetch — SourceActor re-arm (#2286)", () => {
  it("force-arms the actor after a scrape flag (queued) fetch", async () => {
    const db = createTestDb();
    await db.insert(organizations).values({
      id: "org_a",
      name: "Acme",
      slug: "acme",
    });
    await db.insert(sources).values({
      id: "src_news",
      name: "News",
      slug: "news",
      type: "scrape",
      url: "https://example.com/news",
      orgId: "org_a",
      fetchPriority: "normal",
      metadata: JSON.stringify({
        sourceActor: { managed: false, nextAlarmAt: null, lastAlarmAt: "2026-07-01T00:00:00.000Z" },
      }),
    });

    const ensured: Array<{ id: string; force?: boolean }> = [];
    const waited: Promise<unknown>[] = [];
    const app = createTestApp(db, [sourceRoutes], {
      env: {
        STATUS_HUB: statusHubStub,
        SOURCE_ACTOR: {
          getByName: (id: string) => ({
            ensureScheduled: async (sourceId: string, opts?: { force?: boolean }) => {
              ensured.push({ id: sourceId, force: opts?.force });
              expect(id).toBe(sourceId);
            },
          }),
        },
      },
      executionCtx: {
        waitUntil: (p: Promise<unknown>) => {
          waited.push(p);
        },
        passThroughOnException: () => {},
      } as unknown as ExecutionContext,
    });

    const res = await app(
      new Request("https://x.test/v1/sources/src_news/fetch", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { queued?: boolean };
    expect(body.queued).toBe(true);

    await Promise.all(waited);
    expect(ensured).toEqual([{ id: "src_news", force: true }]);
  });
});

describe("PATCH /v1/sources/:id — unpause re-arms SourceActor (#2286)", () => {
  it("notifies onSourceChanged when fetchPriority leaves paused", async () => {
    const db = createTestDb();
    await db.insert(organizations).values({
      id: "org_a",
      name: "Acme",
      slug: "acme",
    });
    await db.insert(sources).values({
      id: "src_paused",
      name: "Paused",
      slug: "paused",
      type: "scrape",
      url: "https://example.com/paused",
      orgId: "org_a",
      fetchPriority: "paused",
      metadata: JSON.stringify({}),
    });

    const changed: string[] = [];
    const waited: Promise<unknown>[] = [];
    const app = createTestApp(db, [sourceRoutes], {
      env: {
        STATUS_HUB: statusHubStub,
        SOURCE_ACTOR: {
          getByName: (id: string) => ({
            onSourceChanged: async (sourceId: string) => {
              changed.push(sourceId);
              expect(id).toBe(sourceId);
            },
          }),
        },
      },
      executionCtx: {
        waitUntil: (p: Promise<unknown>) => {
          waited.push(p);
        },
        passThroughOnException: () => {},
      } as unknown as ExecutionContext,
    });

    const res = await app(
      new Request("https://x.test/v1/sources/src_paused", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fetchPriority: "normal" }),
      }),
    );
    expect(res.status).toBe(200);
    await Promise.all(waited);
    expect(changed).toEqual(["src_paused"]);
  });
});
