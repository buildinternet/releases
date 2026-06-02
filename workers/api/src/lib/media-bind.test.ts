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

  it("wraps a plain URL string in a media object array", () => {
    expect(normalizeMediaBind("https://cdn.example.com/shot.png")).toBe(
      '[{"type":"image","url":"https://cdn.example.com/shot.png"}]',
    );
  });

  it("wraps a WorkOS CDN URL (the bug case from issue #1344)", () => {
    expect(normalizeMediaBind("https://workos.imgix.net/preview.jpg")).toBe(
      '[{"type":"image","url":"https://workos.imgix.net/preview.jpg"}]',
    );
  });

  it("unwraps a JSON-quoted URL string and wraps it in a media object array", () => {
    expect(normalizeMediaBind('"https://x/a.png"')).toBe(
      '[{"type":"image","url":"https://x/a.png"}]',
    );
  });

  it("collapses a non-array, non-URL JSON value to an empty array", () => {
    expect(normalizeMediaBind("null")).toBe("[]");
    expect(normalizeMediaBind("42")).toBe("[]");
  });

  it("passes an empty JSON array through unchanged", () => {
    expect(normalizeMediaBind("[]")).toBe("[]");
  });
});
