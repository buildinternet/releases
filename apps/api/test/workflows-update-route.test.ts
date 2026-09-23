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
import { Hono } from "hono";
import { workflowsRoutes } from "../src/routes/workflows.js";

type EnvStub = Record<string, unknown>;

function mkFetch(env: EnvStub) {
  const app = new Hono();
  const v1 = new Hono();
  v1.route("/", workflowsRoutes);
  app.route("/v1", v1);
  return (body: unknown) =>
    app.fetch(
      new Request("https://x.test/v1/workflows/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
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
    const fetch = mkFetch({ DETERMINISTIC_UPDATE_WORKFLOW: wf });
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
    const fetch = mkFetch({ DETERMINISTIC_UPDATE_WORKFLOW: wf });
    const res = await fetch({ company: "Acme", sourceSlugs: ["src_legacy"] });
    expect(res.status).toBe(202);
    expect(wf.calls[0].params.sourceIdentifiers).toEqual(["src_legacy"]);
  });

  it("400 on validation failure (missing company)", async () => {
    const fetch = mkFetch({ DETERMINISTIC_UPDATE_WORKFLOW: makeWorkflowStub() });
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
    const fetch = mkFetch({ DETERMINISTIC_UPDATE_WORKFLOW: wf });
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
    const fetch = mkFetch({ DETERMINISTIC_UPDATE_WORKFLOW: wf, SOURCE_ACTOR: lockedActor });
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
    const fetch = mkFetch({
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
    const fetch = mkFetch({
      DETERMINISTIC_UPDATE_WORKFLOW: makeWorkflowStub(),
      LATEST_CACHE: killKv,
    });
    const res = await fetch(VALID_BODY);
    expect(res.status).toBe(503);
  });

  it("503 when the workflow binding is absent", async () => {
    const fetch = mkFetch({});
    const res = await fetch(VALID_BODY);
    expect(res.status).toBe(503);
  });
});
