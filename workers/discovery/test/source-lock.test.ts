/**
 * Discovery-side per-source lock helpers (#1814). Exercises the SourceActor
 * cross-script lock wrappers over a fake DO namespace: atomic batch acquire with
 * partial-conflict rollback, conditional release, and fail-open behavior on a
 * throwing stub or an absent binding.
 */

import { describe, it, expect } from "bun:test";
import { tryAcquireSourceLocks, releaseSourceLocks } from "../src/source-lock";
import type { Env } from "../src/types";

/** In-memory stand-in for the SourceActor DO's per-source lock storage. */
function mkEnv(opts: { throwOn?: Set<string> } = {}) {
  const leases = new Map<string, string>(); // sourceId -> owning sessionId
  const stub = (id: string) => ({
    tryAcquireScrapeLock: async (_id: string, sessionId: string) => {
      if (opts.throwOn?.has(id)) throw new Error("boom");
      const owner = leases.get(id);
      if (owner) return { acquired: false, sessionId: owner };
      leases.set(id, sessionId);
      return { acquired: true, sessionId };
    },
    releaseScrapeLock: async (_id: string, sessionId: string) => {
      if (leases.get(id) === sessionId) leases.delete(id);
    },
  });
  const env = {
    SOURCE_ACTOR: {
      idFromName: (id: string) => id,
      get: (id: string) => stub(id),
    },
  } as unknown as Env;
  return { env, leases };
}

describe("source-lock helpers (#1814)", () => {
  it("acquires every free source and reports no conflicts", async () => {
    const { env, leases } = mkEnv();
    const conflicts = await tryAcquireSourceLocks(env, ["src_a", "src_b"], "sess_1");
    expect(conflicts).toEqual([]);
    expect(leases.get("src_a")).toBe("sess_1");
    expect(leases.get("src_b")).toBe("sess_1");
  });

  it("returns the contended sources and rolls back partial acquisitions", async () => {
    const { env, leases } = mkEnv();
    leases.set("src_b", "sess_x"); // already held by another session
    const conflicts = await tryAcquireSourceLocks(env, ["src_a", "src_b"], "sess_1");
    expect(conflicts).toEqual([{ id: "src_b", sessionId: "sess_x" }]);
    // src_a was acquired then rolled back — a rejected batch holds nothing new.
    expect(leases.get("src_a")).toBeUndefined();
    expect(leases.get("src_b")).toBe("sess_x");
  });

  it("release clears the lease for the owning session", async () => {
    const { env, leases } = mkEnv();
    await tryAcquireSourceLocks(env, ["src_a"], "sess_1");
    await releaseSourceLocks(env, ["src_a"], "sess_1");
    expect(leases.get("src_a")).toBeUndefined();
  });

  it("is a no-op (fail-open) when the SOURCE_ACTOR binding is absent", async () => {
    const env = {} as unknown as Env;
    expect(await tryAcquireSourceLocks(env, ["src_a"], "sess_1")).toEqual([]);
    // release must not throw without a binding.
    await releaseSourceLocks(env, ["src_a"], "sess_1");
  });

  it("fails closed: a throwing acquire surfaces a conflict", async () => {
    const { env, leases } = mkEnv({ throwOn: new Set(["src_a"]) });
    leases.set("src_b", "sess_x");
    const conflicts = await tryAcquireSourceLocks(env, ["src_a", "src_b"], "sess_1");
    expect(conflicts).toHaveLength(2);
    expect(conflicts).toEqual(
      expect.arrayContaining([
        { id: "src_a", sessionId: "__lock_unavailable__" },
        { id: "src_b", sessionId: "sess_x" },
      ]),
    );
  });
});
