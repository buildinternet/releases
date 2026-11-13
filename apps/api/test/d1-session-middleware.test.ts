import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { primaryD1Binding } from "@releases/lib/db";
import { chooseD1SessionConstraint, d1ReadSession } from "../src/middleware/d1-session.js";

const BOOKMARK = "0000007b-00000002-00004f6e-a1b2c3d4e5f60718293a4b5c6d7e8f90";

function req(path: string, init: RequestInit = {}) {
  return new Request(`https://api.example.com${path}`, init);
}

describe("chooseD1SessionConstraint", () => {
  it("routes anonymous reads to a replica-eligible session", () => {
    expect(chooseD1SessionConstraint(req("/v1/releases/latest"))).toBe("first-unconstrained");
    expect(chooseD1SessionConstraint(req("/v1/orgs", { method: "HEAD" }))).toBe(
      "first-unconstrained",
    );
  });

  it("keeps writes, credentialed reads, and the web proxy on the primary", () => {
    expect(chooseD1SessionConstraint(req("/v1/orgs", { method: "POST" }))).toBeNull();
    for (const [name, value] of [
      ["authorization", "Bearer relk_x_y"],
      ["cookie", "releases.session=abc"],
      ["x-releases-proxy-key", "k"],
    ]) {
      expect(chooseD1SessionConstraint(req("/v1/orgs", { headers: { [name]: value } }))).toBeNull();
    }
  });

  it("keeps auth and signed-in prefixes on the primary", () => {
    for (const p of [
      "/api/auth/get-session",
      "/oauth2/token",
      "/v1/me",
      "/v1/me/feed",
      "/v1/admin/emails",
    ]) {
      expect(chooseD1SessionConstraint(req(p))).toBeNull();
    }
    // Prefix match is segment-aware.
    expect(chooseD1SessionConstraint(req("/v1/media"))).toBe("first-unconstrained");
  });

  it("ignores inbound bookmarks (D1 rejects junk ones at query time)", () => {
    for (const value of [BOOKMARK, "not-a-real-bookmark", "first-primary"]) {
      expect(
        chooseD1SessionConstraint(req("/v1/orgs", { headers: { "x-d1-bookmark": value } })),
      ).toBe("first-unconstrained");
    }
  });
});

function fakeD1() {
  const calls: string[] = [];
  const db = {
    prepare: () => ({}),
    batch: async () => [],
    withSession(constraint?: string) {
      calls.push(constraint ?? "");
      return { prepare: () => ({}), batch: async () => [], getBookmark: () => BOOKMARK };
    },
  };
  return { db, calls };
}

function appWith(db: unknown) {
  const app = new Hono<{ Bindings: { DB: D1Database } }>();
  app.use("*", d1ReadSession());
  app.all("*", (c) =>
    c.json({ swapped: c.env.DB !== db, primary: primaryD1Binding(c.env.DB) === db }),
  );
  return app;
}

describe("d1ReadSession middleware", () => {
  it("swaps env.DB for a session on anonymous reads", async () => {
    const { db, calls } = fakeD1();
    const env = { DB: db as unknown as D1Database };
    const res = await appWith(db).request("/v1/orgs", {}, env);
    expect(await res.json()).toEqual({ swapped: true, primary: true });
    expect(res.headers.get("x-d1-bookmark")).toBeNull();
    expect(calls).toEqual(["first-unconstrained"]);
    // The shared env object is never mutated.
    expect(env.DB as unknown).toBe(db);
  });

  it("leaves the plain binding in place for primary-routed requests", async () => {
    const { db, calls } = fakeD1();
    const res = await appWith(db).request("/v1/orgs", { method: "POST" }, { DB: db });
    expect(await res.json()).toEqual({ swapped: false, primary: true });
    expect(calls).toEqual([]);
  });

  it("is a no-op on bindings without withSession (test shims)", async () => {
    const shim = { prepare: () => ({}), batch: async () => [] };
    const res = await appWith(shim).request("/v1/orgs", {}, { DB: shim });
    expect(await res.json()).toEqual({ swapped: false, primary: true });
  });
});
