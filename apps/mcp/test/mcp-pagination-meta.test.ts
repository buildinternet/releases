import { describe, it, expect } from "bun:test";
import {
  buildCursorMeta,
  buildSearchMeta,
  decodeReleaseCursor,
  parseFeedLimit,
} from "../src/lib/pagination.js";
import { toBase64Url } from "@buildinternet/releases-core/cursor";

describe("decodeReleaseCursor", () => {
  it("reads the shared publishedAt|fetchedAt|id feed cursor", () => {
    expect(decodeReleaseCursor("2025-01-01T00:00:00Z|2025-01-02T00:00:00Z|rel_abc")).toEqual({
      publishedAt: "2025-01-01T00:00:00Z",
      fetchedAt: "2025-01-02T00:00:00Z",
      id: "rel_abc",
    });
    expect(decodeReleaseCursor("|2025-01-02T00:00:00Z|rel_abc")).toEqual({
      publishedAt: null,
      fetchedAt: "2025-01-02T00:00:00Z",
      id: "rel_abc",
    });
  });

  it("still reads an old base64url publishedAt|id token as a 2-part cursor", () => {
    expect(decodeReleaseCursor(toBase64Url("2025-01-01T00:00:00Z|rel_abc123"))).toEqual({
      publishedAt: "2025-01-01T00:00:00Z",
      fetchedAt: null,
      id: "rel_abc123",
    });
    expect(decodeReleaseCursor(toBase64Url("|rel_xyz"))).toEqual({
      publishedAt: null,
      fetchedAt: null,
      id: "rel_xyz",
    });
  });

  it("returns null for an empty token", () => {
    expect(decodeReleaseCursor("")).toBeNull();
  });

  it("returns null for non-base64 garbage", () => {
    expect(decodeReleaseCursor("not-a-valid-cursor!@#$")).toBeNull();
  });

  it("returns null for a token missing the id half", () => {
    expect(decodeReleaseCursor(toBase64Url("2025-01-01T00:00:00Z|"))).toBeNull();
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

  it("echoes the applied kind filter back to the caller", () => {
    const meta = buildSearchMeta({
      mode: "hybrid",
      limit: 20,
      counts: { catalogHits: 2, releaseHits: 1 },
      kind: "sdk",
    });
    expect(meta.kind).toBe("sdk");
  });

  it("echoes the applied type (section) filter back to the caller", () => {
    const meta = buildSearchMeta({
      mode: "hybrid",
      limit: 20,
      counts: { catalogHits: 2 },
      type: ["catalog", "releases"],
    });
    expect(meta.type).toEqual(["catalog", "releases"]);
  });

  it("omits kind and type keys entirely when no such filters were applied", () => {
    const meta = buildSearchMeta({
      mode: "hybrid",
      limit: 20,
      counts: { releaseHits: 3 },
    });
    expect(meta).not.toHaveProperty("kind");
    expect(meta).not.toHaveProperty("type");
  });
});
