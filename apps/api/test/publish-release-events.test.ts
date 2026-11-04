import { describe, it, expect } from "bun:test";
import { publishReleaseEvents } from "../src/events/publish.js";

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
      get: () => ({
        fetch: async () => {
          throw new Error("hub down");
        },
      }),
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

describe("publishReleaseEvents — hidden-source containment", () => {
  /** Minimal D1 stand-in: answers the visibility lookup, nulls everything else. */
  function fakeDb(row: { hidden: number; deletedAt: string | null } | null | "throw") {
    return {
      prepare: (sql: string) => ({
        bind: () => ({
          first: async () => {
            if (/FROM sources WHERE id/.test(sql)) {
              if (row === "throw") throw new Error("d1 down");
              return row;
            }
            return null;
          },
          all: async () => ({ results: [] }),
        }),
      }),
    } as unknown as D1Database;
  }

  const ctx = {
    src: { name: "x", slug: "x", orgId: null, sourceId: "src_h" },
    inserted: [{ id: "rel_h", title: "t", version: null, publishedAt: null, media: null }],
  };

  for (const [label, row] of [
    ["hidden", { hidden: 1, deletedAt: null }],
    ["soft-deleted", { hidden: 0, deletedAt: "2026-11-01T00:00:00Z" }],
    ["missing", null],
    ["unreadable", "throw"],
  ] as const) {
    it(`publishes nothing for a ${label} source`, async () => {
      const { namespace, calls } = makeHub();
      await publishReleaseEvents({ RELEASE_HUB: namespace as any, DB: fakeDb(row) } as any, ctx);
      expect(calls).toHaveLength(0);
    });
  }

  it("publishes for a visible source", async () => {
    const { namespace, calls } = makeHub();
    await publishReleaseEvents(
      { RELEASE_HUB: namespace as any, DB: fakeDb({ hidden: 0, deletedAt: null }) } as any,
      ctx,
    );
    expect(calls).toHaveLength(1);
  });
});
