/**
 * Discovery-side per-source lock helpers (#1814). Exercises the SourceActor
 * cross-script lock wrappers over a fake DO namespace: batch check/acquire/
 * release semantics and the fail-open behavior on a throwing stub.
 */

import { describe, it, expect } from "bun:test";
import { checkSourceLocks, acquireSourceLocks, releaseSourceLocks } from "../src/source-lock";
import type { Env } from "../src/types";

/** In-memory stand-in for the SourceActor DO's per-source lock storage. */
function mkEnv(opts: { throwOn?: Set<string> } = {}) {
  const leases = new Map<string, string>(); // sourceId -> owning sessionId
  const stub = (id: string) => ({
    checkScrapeLock: async () => {
      if (opts.throwOn?.has(id)) throw new Error("boom");
      const sessionId = leases.get(id);
      return sessionId ? { sessionId } : null;
    },
    acquireScrapeLock: async (_id: string, sessionId: string) => {
      leases.set(id, sessionId);
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
  it("reports only the sources with a live lease", async () => {
    const { env, leases } = mkEnv();
    leases.set("src_b", "sess_x");
    const locked = await checkSourceLocks(env, ["src_a", "src_b", "src_c"]);
    expect(locked).toEqual([{ id: "src_b", sessionId: "sess_x" }]);
  });

  it("acquire then check round-trips the owning session", async () => {
    const { env } = mkEnv();
    await acquireSourceLocks(env, ["src_a", "src_b"], "sess_1");
    const locked = await checkSourceLocks(env, ["src_a", "src_b"]);
    expect(locked.map((l) => l.id).sort()).toEqual(["src_a", "src_b"]);
    expect(locked.every((l) => l.sessionId === "sess_1")).toBe(true);
  });

  it("release clears the lease for the owning session", async () => {
    const { env } = mkEnv();
    await acquireSourceLocks(env, ["src_a"], "sess_1");
    await releaseSourceLocks(env, ["src_a"], "sess_1");
    expect(await checkSourceLocks(env, ["src_a"])).toEqual([]);
  });

  it("is a no-op when the SOURCE_ACTOR binding is absent", async () => {
    const env = {} as unknown as Env;
    expect(await checkSourceLocks(env, ["src_a"])).toEqual([]);
    // acquire/release must not throw without a binding.
    await acquireSourceLocks(env, ["src_a"], "sess_1");
    await releaseSourceLocks(env, ["src_a"], "sess_1");
  });

  it("fails open: a throwing check treats that source as unlocked", async () => {
    const { env, leases } = mkEnv({ throwOn: new Set(["src_a"]) });
    leases.set("src_b", "sess_x");
    const locked = await checkSourceLocks(env, ["src_a", "src_b"]);
    // src_a threw → omitted (fail-open); src_b's real lease still surfaces.
    expect(locked).toEqual([{ id: "src_b", sessionId: "sess_x" }]);
  });
});
