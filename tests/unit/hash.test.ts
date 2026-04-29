import { describe, it, expect } from "bun:test";
import { sha256Hex } from "@releases/core-internal/hash";

describe("sha256Hex", () => {
  it("returns a 64-char hex string", () => {
    const result = sha256Hex("hello");
    expect(result).toMatch(/^[a-f0-9]{64}$/);
  });

  it("handles empty string", () => {
    const result = sha256Hex("");
    expect(result).toMatch(/^[a-f0-9]{64}$/);
    // Known SHA-256 of empty string
    expect(result).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});
