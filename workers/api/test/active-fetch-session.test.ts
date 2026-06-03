import { describe, it, expect } from "bun:test";
import { getActiveFetchSession, getActiveSessionRaw } from "../src/lib/active-fetch-session.js";

/**
 * Build a fake StatusHub stub routing on request path:
 *   GET /active-sources  → { slugs, sessionMap }
 *   GET /sessions/:id     → the session in `sessions[id]`, else 404
 * `onError` (when set) makes every fetch reject, exercising the fail-open path.
 */
function mkHub(opts: {
  sessionMap?: Record<string, string>;
  sessions?: Record<string, unknown>;
  throwOn?: "active-sources" | "session";
}): { fetch: (req: Request) => Promise<Response> } {
  return {
    fetch: async (req: Request) => {
      const path = new URL(req.url).pathname;
      if (path === "/active-sources") {
        if (opts.throwOn === "active-sources") throw new Error("DO down");
        return new Response(
          JSON.stringify({
            slugs: Object.keys(opts.sessionMap ?? {}),
            sessionMap: opts.sessionMap ?? {},
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      const m = path.match(/^\/sessions\/(.+)$/);
      if (m) {
        if (opts.throwOn === "session") throw new Error("DO down");
        const session = (opts.sessions ?? {})[m[1]];
        if (!session) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
        return new Response(JSON.stringify(session), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  };
}

const RUNNING_SESSION = {
  sessionId: "ma-abc",
  type: "update",
  status: "running",
  startedAt: 1_000,
  lastUpdatedAt: 2_000,
  activeSources: ["acme-one"],
  extra: "ignored-by-narrowing",
};

describe("getActiveFetchSession", () => {
  it("returns the narrowed running session for a source with an active fetch", async () => {
    const hub = mkHub({
      sessionMap: { "acme-one": "ma-abc" },
      sessions: { "ma-abc": RUNNING_SESSION },
    });

    const result = await getActiveFetchSession(hub, "acme-one");

    expect(result).toEqual({
      sessionId: "ma-abc",
      status: "running",
      startedAt: 1_000,
      lastUpdatedAt: 2_000,
    });
  });

  it("returns null when the source has no active session mapping", async () => {
    const hub = mkHub({ sessionMap: { "other-source": "ma-xyz" }, sessions: {} });

    const result = await getActiveFetchSession(hub, "acme-one");

    expect(result).toBeNull();
  });

  it("returns null when the mapped session detail 404s", async () => {
    const hub = mkHub({ sessionMap: { "acme-one": "ma-abc" }, sessions: {} });

    const result = await getActiveFetchSession(hub, "acme-one");

    expect(result).toBeNull();
  });

  it("fails open to null when the active-sources lookup throws", async () => {
    const hub = mkHub({ throwOn: "active-sources" });

    const result = await getActiveFetchSession(hub, "acme-one");

    expect(result).toBeNull();
  });

  it("fails open to null when the session detail lookup throws", async () => {
    const hub = mkHub({ sessionMap: { "acme-one": "ma-abc" }, throwOn: "session" });

    const result = await getActiveFetchSession(hub, "acme-one");

    expect(result).toBeNull();
  });

  it("fails open to null on a shape-drifted session (missing/mistyped fields), not coerced garbage", async () => {
    // A payload missing startedAt/lastUpdatedAt must NOT become
    // { startedAt: NaN, lastUpdatedAt: NaN } — the helper's contract is fail-open.
    const malformed = { sessionId: "ma-abc", status: "running" };
    const hub = mkHub({ sessionMap: { "acme-one": "ma-abc" }, sessions: { "ma-abc": malformed } });

    const result = await getActiveFetchSession(hub, "acme-one");

    expect(result).toBeNull();
  });
});

describe("getActiveSessionRaw", () => {
  it("returns the full session payload (not narrowed) for an active source", async () => {
    const hub = mkHub({
      sessionMap: { "acme-one": "ma-abc" },
      sessions: { "ma-abc": RUNNING_SESSION },
    });

    const result = await getActiveSessionRaw(hub, "acme-one");

    expect(result).toEqual(RUNNING_SESSION);
  });

  it("returns null when there is no active session", async () => {
    const hub = mkHub({ sessionMap: {}, sessions: {} });

    expect(await getActiveSessionRaw(hub, "acme-one")).toBeNull();
  });
});
