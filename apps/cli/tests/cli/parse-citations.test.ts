import { describe, it, expect } from "bun:test";
import {
  parseCitationsJson,
  ParseCitationsError,
} from "../../src/cli/commands/admin/overview/parse-citations.js";

const SRC = "/tmp/cite.json";

describe("parseCitationsJson", () => {
  it("accepts a well-formed citation array", () => {
    const raw = JSON.stringify([
      {
        startIndex: 0,
        endIndex: 10,
        sourceUrl: "https://acme.com/post",
        title: "v2 launch",
        citedText: "Acme shipped v2",
      },
    ]);
    const out = parseCitationsJson(raw, SRC);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      startIndex: 0,
      endIndex: 10,
      sourceUrl: "https://acme.com/post",
      title: "v2 launch",
      citedText: "Acme shipped v2",
    });
  });

  it("accepts an empty array", () => {
    expect(parseCitationsJson("[]", SRC)).toEqual([]);
  });

  it("normalizes missing title to null (server treats undefined === null)", () => {
    const raw = JSON.stringify([
      { startIndex: 0, endIndex: 5, sourceUrl: "https://x.com", citedText: "hello" },
    ]);
    const out = parseCitationsJson(raw, SRC);
    expect(out[0]?.title).toBeNull();
  });

  it("rejects malformed JSON with the source path in the error", () => {
    expect(() => parseCitationsJson("not json", SRC)).toThrow(ParseCitationsError);
    try {
      parseCitationsJson("not json", SRC);
    } catch (err) {
      expect((err as Error).message).toContain(SRC);
      expect((err as Error).message).toContain("invalid JSON");
    }
  });

  it("rejects a non-array root", () => {
    expect(() => parseCitationsJson("{}", SRC)).toThrow(/expected a JSON array/);
  });

  it("rejects a citation missing sourceUrl", () => {
    const raw = JSON.stringify([{ startIndex: 0, endIndex: 5, citedText: "hi" }]);
    expect(() => parseCitationsJson(raw, SRC)).toThrow(/sourceUrl/);
  });

  it("rejects a citation missing citedText", () => {
    const raw = JSON.stringify([{ startIndex: 0, endIndex: 5, sourceUrl: "https://x.com" }]);
    expect(() => parseCitationsJson(raw, SRC)).toThrow(/citedText/);
  });

  it("rejects a citation with non-numeric span", () => {
    const raw = JSON.stringify([
      { startIndex: "0", endIndex: 5, sourceUrl: "https://x.com", citedText: "hi" },
    ]);
    expect(() => parseCitationsJson(raw, SRC)).toThrow(/startIndex\/endIndex/);
  });

  it("rejects a null entry inside the array", () => {
    expect(() => parseCitationsJson("[null]", SRC)).toThrow(/must be an object/);
  });

  it("reports the index of the first bad row", () => {
    const raw = JSON.stringify([
      { startIndex: 0, endIndex: 5, sourceUrl: "https://x.com", citedText: "hi" },
      { startIndex: 0, endIndex: 5, sourceUrl: "https://y.com" }, // missing citedText
    ]);
    expect(() => parseCitationsJson(raw, SRC)).toThrow(/citations\[1\]/);
  });
});
