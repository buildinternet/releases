/**
 * Wire contract of POST /v1/workflows/update after #1946: the route no longer
 * proxies to the discovery worker — it runs the shared dispatch gate and
 * creates a DeterministicUpdateWorkflow instance — but the statuses and body
 * shape the CLI depends on are unchanged: 202 {sessionId, status: "running",
 * sourceIdentifiers}, 400 validation, 409 + Retry-After on lock contention,
 * 429 spend cap, 503 when the workflow binding is absent. Admin-scope auth is
 * the /workflows namespace middleware's job (route-namespaces.ts), not tested
 * here.
 */

import { describe, it, expect } from "bun:test";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import { workflowsRoutes } from "../src/routes/workflows.js";
import { createTestApp, createTestDb, type TestDb } from "./setup";

type EnvStub = Record<string, unknown>;

async function seedAcme(db: TestDb) {
  await db.insert(organizations).values({
    id: "org_acme",
    name: "Acme Industries",
    slug: "acme",
  });
  await db.insert(sources).values([
    {
      id: "src_a",
      orgId: "org_acme",
      name: "A",
      slug: "a",
      type: "feed",
      url: "https://a.example",
    },
    {
      id: "src_b",
      orgId: "org_acme",
      name: "B",
      slug: "b",
      type: "feed",
      url: "https://b.example",
    },
  ]);
}

async function mkFetch(env: EnvStub, extra?: (db: TestDb) => Promise<void>) {
  const db = createTestDb();
  await seedAcme(db);
  if (extra) await extra(db);
  const fetch = createTestApp(db, [workflowsRoutes], { env });
  return (body: unknown) =>
    fetch(
      new Request("https://x.test/v1/workflows/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
}

function makeWorkflowStub() {
  const calls: Array<{ id: string; params: Record<string, unknown> }> = [];
  return {
    calls,
    create: async (opts: { id: string; params: Record<string, unknown> }) => {
      calls.push(opts);
      return {} as never;
    },
  };
}

const VALID_BODY = {
  company: "Acme",
  sourceIdentifiers: ["src_a", "src_b"],
  orgId: "org_acme",
  correlationId: "test",
};

describe("POST /v1/workflows/update", () => {
  it("202 with sessionId + echoed sourceIdentifiers on success", async () => {
    const wf = makeWorkflowStub();
    const fetch = await mkFetch({ DETERMINISTIC_UPDATE_WORKFLOW: wf });
    const res = await fetch(VALID_BODY);
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      sessionId: string;
      status: string;
      sourceIdentifiers: string[];
    };
    expect(body.status).toBe("running");
    expect(body.sessionId).toMatch(/^det-/);
    expect(body.sourceIdentifiers).toEqual(["src_a", "src_b"]);
    expect(wf.calls).toHaveLength(1);
    expect(wf.calls[0].params.sessionId).toBe(body.sessionId);
  });

  it("accepts the legacy sourceSlugs alias", async () => {
    const wf = makeWorkflowStub();
    const fetch = await mkFetch({ DETERMINISTIC_UPDATE_WORKFLOW: wf });
    const res = await fetch({ company: "Acme", sourceSlugs: ["src_legacy"] });
    expect(res.status).toBe(202);
    expect(wf.calls[0].params.sourceIdentifiers).toEqual(["src_legacy"]);
  });

  it("400 on validation failure (missing company)", async () => {
    const fetch = await mkFetch({ DETERMINISTIC_UPDATE_WORKFLOW: makeWorkflowStub() });
    const res = await fetch({ sourceIdentifiers: ["src_a"] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("validation");
    expect(body.error.message).toContain("company");
  });

  it("400 (not 500) on non-object JSON bodies", async () => {
    // JSON.parse happily yields null / arrays / scalars — the route must
    // reject them before field access instead of throwing a TypeError.
    const wf = makeWorkflowStub();
    const fetch = await mkFetch({ DETERMINISTIC_UPDATE_WORKFLOW: wf });
    for (const body of [null, ["src_a"], "x", 42]) {
      const res = await fetch(body);
      expect(res.status).toBe(400);
    }
    expect(wf.calls).toHaveLength(0);
  });

  it("409 + Retry-After when the per-source lock is held", async () => {
    const lockedActor = {
      idFromName: (name: string) => name,
      get: () => ({
        tryAcquireScrapeLock: async () => ({ acquired: false, sessionId: "det-owner" }),
        releaseScrapeLock: async () => {},
      }),
    };
    const wf = makeWorkflowStub();
    const fetch = await mkFetch({ DETERMINISTIC_UPDATE_WORKFLOW: wf, SOURCE_ACTOR: lockedActor });
    const res = await fetch(VALID_BODY);
    expect(res.status).toBe(409);
    expect(res.headers.get("Retry-After")).toBe("900");
    expect(wf.calls).toHaveLength(0);
  });

  it("429 when the daily spend cap is reached", async () => {
    const cappedKv = {
      get: async (key: string) => (key.startsWith("ma:spend:global") ? "999999" : null),
      put: async () => {},
    };
    const fetch = await mkFetch({
      DETERMINISTIC_UPDATE_WORKFLOW: makeWorkflowStub(),
      LATEST_CACHE: cappedKv,
    });
    const res = await fetch(VALID_BODY);
    expect(res.status).toBe(429);
  });

  it("503 when the kill switch is set in KV", async () => {
    const killKv = {
      get: async (key: string) => (key === "ma:sessions:disabled" ? "1" : null),
      put: async () => {},
    };
    const fetch = await mkFetch({
      DETERMINISTIC_UPDATE_WORKFLOW: makeWorkflowStub(),
      LATEST_CACHE: killKv,
    });
    const res = await fetch(VALID_BODY);
    expect(res.status).toBe(503);
  });

  it("503 when the workflow binding is absent", async () => {
    const fetch = await mkFetch({});
    const res = await fetch(VALID_BODY);
    expect(res.status).toBe(503);
  });

  it("scopes a shared bare slug to the named org (#2525)", async () => {
    const wf = makeWorkflowStub();
    const fetch = await mkFetch({ DETERMINISTIC_UPDATE_WORKFLOW: wf }, async (db) => {
      await db.insert(organizations).values([
        { id: "org_harvey", name: "Harvey", slug: "harvey" },
        { id: "org_firebase", name: "Firebase", slug: "firebase" },
      ]);
      await db.insert(sources).values([
        {
          id: "src_harvey_notes",
          orgId: "org_harvey",
          name: "Harvey notes",
          slug: "release-notes",
          type: "scrape",
          url: "https://harvey.example/notes",
        },
        {
          id: "src_firebase_notes",
          orgId: "org_firebase",
          name: "Firebase notes",
          slug: "release-notes",
          type: "feed",
          url: "https://firebase.example/notes",
        },
        {
          id: "src_harvey_only",
          orgId: "org_harvey",
          name: "Harvey only",
          slug: "platform",
          type: "scrape",
          url: "https://harvey.example/platform",
        },
      ]);
    });

    const scoped = await fetch({ company: "harvey", sourceIdentifiers: ["release-notes"] });
    expect(scoped.status).toBe(202);
    const scopedBody = (await scoped.json()) as { sourceIdentifiers: string[] };
    expect(scopedBody.sourceIdentifiers).toEqual(["src_harvey_notes"]);
    expect(wf.calls[0].params.sourceIdentifiers).toEqual(["src_harvey_notes"]);
    expect(wf.calls[0].params.orgId).toBe("org_harvey");

    const byName = await fetch({ company: "Harvey", sourceIdentifiers: ["platform"] });
    expect(byName.status).toBe(202);
    expect(wf.calls[1].params.sourceIdentifiers).toEqual(["src_harvey_only"]);

    const missing = await fetch({ company: "firebase", sourceIdentifiers: ["platform"] });
    expect(missing.status).toBe(404);

    const coordinate = await fetch({
      company: "harvey",
      sourceIdentifiers: ["harvey/release-notes"],
    });
    expect(coordinate.status).toBe(202);
    expect(wf.calls[2].params.sourceIdentifiers).toEqual(["src_harvey_notes"]);

    const mismatch = await fetch({
      company: "harvey",
      sourceIdentifiers: ["firebase/release-notes"],
    });
    expect(mismatch.status).toBe(409);
    const mismatchBody = (await mismatch.json()) as { error: { code: string; message: string } };
    expect(mismatchBody.error.code).toBe("conflict");
    expect(mismatchBody.error.message).toContain("firebase");

    const wrongId = await fetch({
      orgId: "org_harvey",
      company: "Harvey",
      sourceIdentifiers: ["src_firebase_notes"],
    });
    expect(wrongId.status).toBe(409);
  });

  it("rejects an ambiguous bare slug when company does not name an org", async () => {
    const wf = makeWorkflowStub();
    const fetch = await mkFetch({ DETERMINISTIC_UPDATE_WORKFLOW: wf }, async (db) => {
      await db.insert(organizations).values([
        { id: "org_harvey", name: "Harvey", slug: "harvey" },
        { id: "org_firebase", name: "Firebase", slug: "firebase" },
      ]);
      await db.insert(sources).values([
        {
          id: "src_harvey_notes",
          orgId: "org_harvey",
          name: "Harvey notes",
          slug: "release-notes",
          type: "scrape",
          url: "https://harvey.example/notes",
        },
        {
          id: "src_firebase_notes",
          orgId: "org_firebase",
          name: "Firebase notes",
          slug: "release-notes",
          type: "feed",
          url: "https://firebase.example/notes",
        },
      ]);
    });

    const res = await fetch({ company: "Incident label", sourceIdentifiers: ["release-notes"] });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; details: { candidates: Array<{ id: string; orgSlug: string }> } };
    };
    expect(body.error.code).toBe("conflict");
    expect(body.error.details.candidates.map((c) => c.id).toSorted()).toEqual([
      "src_firebase_notes",
      "src_harvey_notes",
    ]);
    expect(wf.calls).toHaveLength(0);

    const unique = await fetch({ company: "Incident label", sourceIdentifiers: ["a"] });
    expect(unique.status).toBe(202);
    expect(wf.calls[0].params.sourceIdentifiers).toEqual(["src_a"]);
  });
});
