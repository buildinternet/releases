import { describe, it, expect } from "bun:test";
import { isDurableObjectReset, recordWorkflowFailure } from "../src/workflows/_shared.js";

const RESET_MSG = "Durable Object reset because its code was updated.";

describe("isDurableObjectReset", () => {
  it("matches the Cloudflare DO code-update reset message", () => {
    expect(isDurableObjectReset(RESET_MSG)).toBe(true);
  });

  it("matches when the reset message is wrapped with a step prefix", () => {
    expect(isDurableObjectReset(`fetch sanity-studio: ${RESET_MSG}`)).toBe(true);
  });

  it("does not match an overloaded error or unrelated failures", () => {
    expect(isDurableObjectReset("Durable Object is overloaded. Too many requests queued.")).toBe(
      false,
    );
    expect(isDurableObjectReset("Timed out after 5m")).toBe(false);
    expect(isDurableObjectReset("")).toBe(false);
  });
});

/**
 * Minimal drizzle-shaped stub: records whether the insert chain was invoked.
 * `recordWorkflowFailure` awaits `db.insert(...).values(...).onConflictDoUpdate(...)`.
 */
function fakeDb() {
  const calls = { insert: 0 };
  const chain = {
    values: () => chain,
    onConflictDoUpdate: async () => undefined,
  };
  return {
    calls,
    insert: () => {
      calls.insert++;
      return chain;
    },
  };
}

describe("recordWorkflowFailure", () => {
  const base = {
    idPrefix: "wf-fail-",
    scheduledTime: 1,
    sourceId: "src_x",
    stepName: "fetch-and-persist",
    logTag: "poll-fetch-workflow",
  };

  it("skips the failure-row write for a Durable Object reset (deploy churn)", async () => {
    const db = fakeDb();
    await recordWorkflowFailure(db, { ...base, error: RESET_MSG });
    expect(db.calls.insert).toBe(0);
  });

  it("records a row for a genuine failure", async () => {
    const db = fakeDb();
    await recordWorkflowFailure(db, { ...base, error: "Timed out after 5m" });
    expect(db.calls.insert).toBe(1);
  });
});
