import { describe, it, expect } from "bun:test";
import { configHash, parseSelfDeclared, setSelfDeclaredInMetadata } from "./self-declared.js";

describe("selfDeclared metadata helpers", () => {
  it("returns null for empty/invalid metadata", () => {
    expect(parseSelfDeclared(null)).toBeNull();
    expect(parseSelfDeclared("{}")).toBeNull();
    expect(parseSelfDeclared("not json")).toBeNull();
  });

  it("round-trips a marker and preserves other keys", () => {
    const meta = JSON.stringify({ notice: { message: "hi" } });
    const out = setSelfDeclaredInMetadata(meta, {
      fields: ["description"],
      source: "well-known",
      configHash: "abc",
      syncedAt: "2026-06-05T00:00:00.000Z",
    });
    const parsed = JSON.parse(out);
    expect(parsed.notice).toEqual({ message: "hi" });
    expect(parseSelfDeclared(out)?.fields).toEqual(["description"]);
    expect(parseSelfDeclared(out)?.source).toBe("well-known");
  });

  it("ignores a malformed marker", () => {
    const meta = JSON.stringify({ selfDeclared: { fields: "nope" } });
    expect(parseSelfDeclared(meta)).toBeNull();
  });
});

describe("configHash", () => {
  it("is deterministic for the same input", () => {
    expect(configHash({ a: 1, b: 2 })).toBe(configHash({ a: 1, b: 2 }));
  });
  it("distinguishes different inputs", () => {
    expect(configHash({ a: 1 })).not.toBe(configHash({ a: 2 }));
  });
  it("does not throw on undefined", () => {
    expect(typeof configHash(undefined)).toBe("string");
  });
});
