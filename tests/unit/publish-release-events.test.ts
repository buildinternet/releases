import { describe, it, expect } from "bun:test";
import { publishReleaseEvents } from "../../workers/api/src/events/publish.js";

function makeHub() {
  const calls: Array<{ url: string; method?: string; body?: string }> = [];
  const stub = {
    fetch: async (req: Request) => {
      calls.push({ url: req.url, method: req.method, body: await req.text() });
      return new Response(JSON.stringify({ published: 1 }), {
        headers: { "Content-Type": "application/json" },
      });
    },
  };
  const namespace = {
    idFromName: (name: string) => name as any,
    get: () => stub as any,
  };
  return { namespace, calls };
}

describe("publishReleaseEvents", () => {
  it("POSTs /publish with mapped payloads to the global DO", async () => {
    const { namespace, calls } = makeHub();
    await publishReleaseEvents(
      { RELEASE_HUB: namespace as any },
      {
        src: { name: "Claude Code", slug: "claude-code", orgId: "org_a", sourceId: "src_a" },
        inserted: [{ id: "rel_a", title: "t", version: null, publishedAt: null, media: null }],
      },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toMatch(/\/publish$/);
    const body = JSON.parse(calls[0].body ?? "{}");
    expect(body.events).toHaveLength(1);
    expect(body.events[0].sourceSlug).toBe("claude-code");
  });

  it("is a no-op on empty inserted arrays (no DO call)", async () => {
    const { namespace, calls } = makeHub();
    await publishReleaseEvents(
      { RELEASE_HUB: namespace as any },
      { src: { name: "x", slug: "x", orgId: "org_a", sourceId: "src_a" }, inserted: [] },
    );
    expect(calls).toHaveLength(0);
  });

  it("swallows errors from the hub (ingestion must not fail on publish errors)", async () => {
    const namespace = {
      idFromName: (n: string) => n,
      get: () => ({ fetch: async () => { throw new Error("hub down"); } }),
    };
    const result = await publishReleaseEvents(
      { RELEASE_HUB: namespace as any },
      {
        src: { name: "x", slug: "x", orgId: "org_a", sourceId: "src_a" },
        inserted: [{ id: "r", title: "t", version: null, publishedAt: null, media: null }],
      },
    );
    expect(result).toBeUndefined();
  });
});
