import { describe, it, expect } from "bun:test";
import { encodeCursor, decodeCursor } from "../../workers/api/src/routes/fetch-log-cursor";

describe("fetch-log cursor helpers", () => {
  it("round-trips a cursor", () => {
    const c = { createdAt: "2026-04-18T21:12:04.001Z", id: "fl_abc123" };
    const token = encodeCursor(c);
    expect(typeof token).toBe("string");
    expect(token).not.toContain("|");
    expect(decodeCursor(token)).toEqual(c);
  });

  it("returns null for malformed input", () => {
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor("not-base64-$$$")).toBeNull();
    expect(decodeCursor(btoa("missing-separator"))).toBeNull();
  });

  it("is URL-safe (no + / =)", () => {
    const c = { createdAt: "2026-04-18T21:12:04.001Z", id: "fl_abc123" };
    const token = encodeCursor(c);
    expect(token).not.toMatch(/[+/=]/);
  });
});
