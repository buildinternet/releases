import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { notifyOrgDrain } from "../src/lib/org-drain-notify.js";
import type { OrgActor } from "../src/org-actor.js";

function mkNamespace(ensure: (orgId: string) => Promise<void>): DurableObjectNamespace<OrgActor> {
  return {
    getByName(_id: string) {
      return { ensureDrainScheduled: ensure };
    },
  } as unknown as DurableObjectNamespace<OrgActor>;
}

function withFlags(message: string, flags: { retryable?: boolean; overloaded?: boolean }): Error {
  return Object.assign(new Error(message), flags);
}

describe("notifyOrgDrain", () => {
  let warnSpy: ReturnType<typeof mock>;
  let originalWarn: typeof console.warn;

  beforeEach(() => {
    originalWarn = console.warn;
    warnSpy = mock(() => {});
    console.warn = warnSpy as unknown as typeof console.warn;
  });

  afterEach(() => {
    console.warn = originalWarn;
  });

  it("is a no-op when the binding is absent", async () => {
    await notifyOrgDrain(undefined, "org_x", "test");
  });

  it("arms the OrgActor and retries transient DO errors", async () => {
    const calls: string[] = [];
    let attempts = 0;
    await notifyOrgDrain(
      mkNamespace(async (id) => {
        attempts++;
        if (attempts === 1) throw withFlags("reset", { retryable: true });
        calls.push(id);
      }),
      "org_x",
      "test",
    );
    expect(attempts).toBe(2);
    expect(calls).toEqual(["org_x"]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does not retry overloaded errors and logs once", async () => {
    let attempts = 0;
    await notifyOrgDrain(
      mkNamespace(async () => {
        attempts++;
        throw withFlags("Durable Object is overloaded", {
          retryable: true,
          overloaded: true,
        });
      }),
      "org_x",
      "test",
    );
    expect(attempts).toBe(1);
    expect(warnSpy).toHaveBeenCalled();
  });
});
