import { describe, expect, it } from "bun:test";
import { StatusHub } from "../src/status-hub.js";

function hub() {
  const store = new Map<string, unknown>();
  const ctx = {
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => {
        store.set(key, value);
      },
      list: async ({ prefix }: { prefix: string }) => {
        const out = new Map<string, unknown>();
        for (const [key, value] of store) {
          if (key.startsWith(prefix)) out.set(key, value);
        }
        return out;
      },
      getAlarm: async () => null,
      setAlarm: async () => {},
    },
    getWebSockets: () => [],
  };
  const actor = new (StatusHub as unknown as new (ctx: unknown, env: unknown) => StatusHub)(
    ctx,
    {},
  );
  return { actor, store };
}

async function post(actor: StatusHub, body: Record<string, unknown>) {
  await actor.fetch(
    new Request("https://do/event", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("StatusHub terminal sessions", () => {
  it("keeps a completed session completed when a later error arrives", async () => {
    const { actor, store } = hub();
    await post(actor, { type: "session:start", sessionId: "ses_1", company: "Acme" });
    await post(actor, { type: "session:complete", sessionId: "ses_1" });
    await post(actor, { type: "session:error", sessionId: "ses_1", error: "late" });
    const session = store.get("session:ses_1") as { status: string; error?: string };
    expect(session.status).toBe("complete");
    expect(session.error).toBeUndefined();
  });

  it("a late complete replaces a sweep timeout", async () => {
    const { actor, store } = hub();
    await post(actor, { type: "session:start", sessionId: "ses_1", company: "Acme" });
    const started = store.get("session:ses_1") as { lastUpdatedAt: number };
    started.lastUpdatedAt = Date.now() - 20 * 60 * 1000;
    store.set("session:ses_1", started);

    const listed = await actor.fetch(new Request("https://do/sessions"));
    expect(listed.status).toBe(200);
    const swept = store.get("session:ses_1") as { status: string; error?: string };
    expect(swept.status).toBe("error");
    expect(swept.error).toBe("Session timed out (no updates received)");

    await post(actor, { type: "session:complete", sessionId: "ses_1" });
    const done = store.get("session:ses_1") as { status: string; error?: string };
    expect(done.status).toBe("complete");
    expect(done.error).toBeUndefined();
  });
});
