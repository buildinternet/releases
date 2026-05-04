import { describe, it, expect } from "bun:test";
import {
  buildCursorMeta,
  buildSearchMeta,
  decodeReleaseCursor,
  encodeReleaseCursor,
  parseFeedLimit,
} from "../../workers/mcp/src/lib/pagination.js";

describe("encodeReleaseCursor / decodeReleaseCursor", () => {
  it("round-trips a full (publishedAt, id) cursor", () => {
    const enc = encodeReleaseCursor({
      lastPublishedAt: "2025-01-01T00:00:00Z",
      lastId: "rel_abc123",
    });
    expect(decodeReleaseCursor(enc)).toEqual({
      lastPublishedAt: "2025-01-01T00:00:00Z",
      lastId: "rel_abc123",
    });
  });

  it("round-trips a cursor with null publishedAt", () => {
    const enc = encodeReleaseCursor({ lastPublishedAt: null, lastId: "rel_xyz" });
    expect(decodeReleaseCursor(enc)).toEqual({ lastPublishedAt: null, lastId: "rel_xyz" });
  });

  it("returns null for an empty token", () => {
    expect(decodeReleaseCursor("")).toBeNull();
  });

  it("returns null for non-base64 garbage", () => {
    expect(decodeReleaseCursor("not-a-valid-cursor!@#$")).toBeNull();
  });

  it("returns null for a token missing the id half", () => {
    // Encodes "2025-01-01T00:00:00Z|" — separator with empty id.
    const broken = btoa("2025-01-01T00:00:00Z|").replace(/=+$/, "");
    expect(decodeReleaseCursor(broken)).toBeNull();
  });
});

describe("buildCursorMeta", () => {
  it("populates kind=cursor + nextCursor when hasMore", () => {
    const meta = buildCursorMeta({
      returned: 10,
      limit: 10,
      hasMore: true,
      nextCursor: "tok",
    });
    expect(meta).toEqual({
      kind: "cursor",
      returned: 10,
      limit: 10,
      hasMore: true,
      nextCursor: "tok",
    });
  });

  it("omits nextCursor when hasMore is false", () => {
    const meta = buildCursorMeta({ returned: 3, limit: 10, hasMore: false, nextCursor: null });
    expect(meta).toEqual({ kind: "cursor", returned: 3, limit: 10, hasMore: false });
    expect(meta).not.toHaveProperty("nextCursor");
  });

  it("omits nextCursor when token is null even if hasMore claims true", () => {
    const meta = buildCursorMeta({ returned: 3, limit: 3, hasMore: true, nextCursor: null });
    expect(meta).not.toHaveProperty("nextCursor");
  });
});

describe("parseFeedLimit", () => {
  it("returns the default when limit is undefined", () => {
    expect(parseFeedLimit(undefined)).toBe(50);
  });

  it("clamps to the max", () => {
    expect(parseFeedLimit(10_000)).toBe(200);
  });

  it("rejects non-positive values and returns the default", () => {
    expect(parseFeedLimit(0)).toBe(50);
    expect(parseFeedLimit(-1)).toBe(50);
  });

  it("floors fractional values", () => {
    expect(parseFeedLimit(7.9)).toBe(7);
  });
});

describe("buildSearchMeta", () => {
  it("returns hitCap=false when no section reaches the limit", () => {
    const meta = buildSearchMeta({
      mode: "hybrid",
      limit: 20,
      counts: { orgHits: 1, catalogHits: 5, releaseHits: 3, chunkHits: 0 },
    });
    expect(meta).toEqual({
      mode: "hybrid",
      limit: 20,
      returned: 9,
      hitCap: false,
      hitCounts: { orgHits: 1, catalogHits: 5, releaseHits: 3, chunkHits: 0 },
      degraded: false,
    });
  });

  it("returns hitCap=true when any section reaches the limit", () => {
    const meta = buildSearchMeta({
      mode: "hybrid",
      limit: 20,
      counts: { orgHits: 1, catalogHits: 20, releaseHits: 3 },
    });
    expect(meta.hitCap).toBe(true);
    expect(meta.returned).toBe(24);
  });

  it("forces effective mode to lexical when degraded=true", () => {
    const meta = buildSearchMeta({
      mode: "hybrid",
      limit: 20,
      counts: { releaseHits: 5 },
      degraded: true,
    });
    expect(meta.mode).toBe("lexical");
    expect(meta.degraded).toBe(true);
  });

  it("preserves mode when degraded=false", () => {
    const meta = buildSearchMeta({
      mode: "semantic",
      limit: 20,
      counts: { releaseHits: 0 },
      degraded: false,
    });
    expect(meta.mode).toBe("semantic");
    expect(meta.degraded).toBe(false);
  });

  it("only includes hitCount sections that were actually counted", () => {
    const meta = buildSearchMeta({
      mode: "hybrid",
      limit: 20,
      counts: { releaseHits: 3, chunkHits: 1 },
    });
    expect(meta.hitCounts).toEqual({ releaseHits: 3, chunkHits: 1 });
    expect(meta.hitCounts).not.toHaveProperty("orgHits");
    expect(meta.hitCounts).not.toHaveProperty("catalogHits");
  });

  it("returned=0 with hitCap=false when no hits and limit>0", () => {
    const meta = buildSearchMeta({
      mode: "hybrid",
      limit: 20,
      counts: { orgHits: 0, catalogHits: 0, releaseHits: 0, chunkHits: 0 },
    });
    expect(meta.returned).toBe(0);
    expect(meta.hitCap).toBe(false);
  });
});
