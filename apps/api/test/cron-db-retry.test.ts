import { describe, expect, it } from "bun:test";
import { crashMessage, withTransientDbRetry } from "../src/lib/cron-db-retry";

function drizzleError(causeMessage: string): Error {
  return new Error('Failed query: select "id" from "sources_active" params: 1', {
    cause: new Error(causeMessage),
  });
}

describe("crashMessage", () => {
  it("leads with the D1 cause hidden behind Drizzle's Failed query wrapper", () => {
    const msg = crashMessage(
      drizzleError("D1_ERROR: D1 DB is overloaded. Too many resources consumed"),
    );
    expect(msg.startsWith("D1_ERROR: D1 DB is overloaded")).toBe(true);
    expect(msg).toContain("[DB_OVERLOADED]");
    expect(msg).toContain("Failed query:");
  });

  it("surfaces a non-transient cause too", () => {
    const msg = crashMessage(drizzleError("D1_ERROR: no such column: actor_managed: SQLITE_ERROR"));
    expect(msg.startsWith("D1_ERROR: no such column: actor_managed")).toBe(true);
  });

  it("leaves a plain error unchanged", () => {
    expect(crashMessage(new Error("boom"))).toBe("boom");
    expect(crashMessage("boom")).toBe("boom");
  });
});

describe("withTransientDbRetry", () => {
  it("retries once on a transient D1 error", async () => {
    let calls = 0;
    const out = await withTransientDbRetry(
      "t",
      async () => {
        calls += 1;
        if (calls === 1) throw drizzleError("D1_ERROR: D1 DB is overloaded.");
        return "ok";
      },
      0,
    );
    expect(out).toBe("ok");
    expect(calls).toBe(2);
  });

  it("rethrows a hard error without retrying", async () => {
    let calls = 0;
    await expect(
      withTransientDbRetry(
        "t",
        async () => {
          calls += 1;
          throw drizzleError("D1_ERROR: no such column: x: SQLITE_ERROR");
        },
        0,
      ),
    ).rejects.toThrow("Failed query");
    expect(calls).toBe(1);
  });

  it("gives up after the single retry", async () => {
    let calls = 0;
    await expect(
      withTransientDbRetry(
        "t",
        async () => {
          calls += 1;
          throw drizzleError("D1_ERROR: D1 DB is overloaded.");
        },
        0,
      ),
    ).rejects.toThrow("Failed query");
    expect(calls).toBe(2);
  });
});
