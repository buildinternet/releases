import { describe, it, expect } from "bun:test";
import { sha256Hex } from "./hash.js";

describe("sha256Hex", () => {
  it("handles empty string", () => {
    const result = sha256Hex("");
    expect(result).toMatch(/^[a-f0-9]{64}$/);
    // Known SHA-256 of empty string
    expect(result).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});
