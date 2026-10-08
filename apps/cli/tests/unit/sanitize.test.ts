import { describe, it, expect } from "bun:test";
import { stripAnsi } from "../../src/lib/sanitize.js";

describe("stripAnsi", () => {
  it("strips color codes", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
  });

  it("strips bold codes", () => {
    expect(stripAnsi("\x1b[1mbold\x1b[0m")).toBe("bold");
  });

  it("leaves plain text unchanged", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });

  it("handles empty string", () => {
    expect(stripAnsi("")).toBe("");
  });

  it("strips multiple escape sequences", () => {
    expect(stripAnsi("\x1b[31m\x1b[1mred bold\x1b[0m normal")).toBe("red bold normal");
  });
});
