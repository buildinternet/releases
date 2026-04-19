import { describe, it, expect } from "bun:test";
import { mergeSourceMetadata } from "../../workers/api/src/routes/sources.js";

describe("mergeSourceMetadata", () => {
  it("returns the patch when existing is null", () => {
    expect(mergeSourceMetadata(null, { a: 1 })).toEqual({ a: 1 });
  });

  it("returns the patch when existing is invalid JSON", () => {
    expect(mergeSourceMetadata("not-json{", { a: 1 })).toEqual({ a: 1 });
  });

  it("treats an empty-string existing as empty object", () => {
    expect(mergeSourceMetadata("", { a: 1 })).toEqual({ a: 1 });
  });

  it("shallow-merges patch into existing", () => {
    const existing = JSON.stringify({ a: 1, b: 2 });
    expect(mergeSourceMetadata(existing, { b: 99, c: 3 })).toEqual({ a: 1, b: 99, c: 3 });
  });

  it("deletes keys whose patch value is null", () => {
    const existing = JSON.stringify({ a: 1, fetchEtag: "W/old", b: 2 });
    expect(mergeSourceMetadata(existing, { fetchEtag: null })).toEqual({ a: 1, b: 2 });
  });

  it("deletes keys that are absent from existing without error", () => {
    const existing = JSON.stringify({ a: 1 });
    expect(mergeSourceMetadata(existing, { nonexistent: null, a: 2 })).toEqual({ a: 2 });
  });

  it("does not mutate nested objects (shallow)", () => {
    const existing = JSON.stringify({ nested: { keep: true, replace: 1 } });
    expect(mergeSourceMetadata(existing, { nested: { replace: 2 } })).toEqual({
      nested: { replace: 2 },
    });
  });

  it("treats an array stored as metadata as empty base", () => {
    const existing = JSON.stringify(["a", "b"]);
    expect(mergeSourceMetadata(existing, { x: 1 })).toEqual({ x: 1 });
  });

  it("treats a JSON scalar stored as metadata as empty base", () => {
    expect(mergeSourceMetadata("42", { x: 1 })).toEqual({ x: 1 });
  });

  it("handles the fetchUrl-rotation case (clear old headers, set new URL)", () => {
    const existing = JSON.stringify({
      fetchUrl: "https://old.example/data.json",
      fetchEtag: 'W/"abc"',
      fetchLastModified: "Sat, 18 Apr 2026 18:53:02 GMT",
    });
    const patch = {
      fetchUrl: "https://new.example/data.json",
      fetchEtag: null,
      fetchLastModified: null,
    };
    expect(mergeSourceMetadata(existing, patch)).toEqual({
      fetchUrl: "https://new.example/data.json",
    });
  });
});
