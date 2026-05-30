import { describe, it, expect } from "bun:test";
import { normalizeMediaBind } from "./media-bind.js";

describe("normalizeMediaBind", () => {
  it("passes a JSON string through unchanged", () => {
    expect(normalizeMediaBind('[{"type":"image","url":"https://x/a.png"}]')).toBe(
      '[{"type":"image","url":"https://x/a.png"}]',
    );
  });

  it("maps null/undefined to an empty JSON array", () => {
    expect(normalizeMediaBind(null)).toBe("[]");
    expect(normalizeMediaBind(undefined)).toBe("[]");
  });

  it("stringifies an array value instead of binding a non-primitive", () => {
    expect(normalizeMediaBind([{ type: "image", url: "https://x/a.png" }])).toBe(
      '[{"type":"image","url":"https://x/a.png"}]',
    );
  });

  it("stringifies an object value", () => {
    expect(normalizeMediaBind({ url: "https://x/a.png" })).toBe('{"url":"https://x/a.png"}');
  });
});
