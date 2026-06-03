import { describe, it, expect } from "bun:test";
import {
  isValidNoticeCoordinate,
  parseNotice,
  setNoticeInMetadata,
  formatNoticePointer,
} from "./notice";

describe("isValidNoticeCoordinate", () => {
  it("accepts one or two slug segments", () => {
    expect(isValidNoticeCoordinate("windsurf")).toBe(true);
    expect(isValidNoticeCoordinate("cognition/devin")).toBe(true);
    expect(isValidNoticeCoordinate("my-org/my_product.v2")).toBe(true);
  });
  it("rejects schemes, leading/trailing slashes, and 3+ segments", () => {
    expect(isValidNoticeCoordinate("/windsurf")).toBe(false);
    expect(isValidNoticeCoordinate("cognition/")).toBe(false);
    expect(isValidNoticeCoordinate("a/b/c")).toBe(false);
    expect(isValidNoticeCoordinate("https://x.com")).toBe(false);
    expect(isValidNoticeCoordinate("")).toBe(false);
  });
});

describe("parseNotice", () => {
  it("returns the notice sub-object when present", () => {
    const meta = JSON.stringify({
      feedUrl: "x",
      notice: { message: "Hi", coordinate: "cognition/devin" },
    });
    expect(parseNotice(meta)).toEqual({ message: "Hi", coordinate: "cognition/devin" });
  });
  it("returns null for absent notice, null metadata, or malformed JSON", () => {
    expect(parseNotice(JSON.stringify({ feedUrl: "x" }))).toBeNull();
    expect(parseNotice(null)).toBeNull();
    expect(parseNotice(undefined)).toBeNull();
    expect(parseNotice("{not json")).toBeNull();
    expect(parseNotice(JSON.stringify({ notice: { message: "" } }))).toBeNull();
  });
});

describe("setNoticeInMetadata", () => {
  it("sets the notice key while preserving other keys", () => {
    const out = setNoticeInMetadata(JSON.stringify({ feedUrl: "x" }), { message: "Hi" });
    expect(JSON.parse(out)).toEqual({ feedUrl: "x", notice: { message: "Hi" } });
  });
  it("clears the notice key on null, preserving other keys", () => {
    const meta = JSON.stringify({ feedUrl: "x", notice: { message: "Hi" } });
    expect(JSON.parse(setNoticeInMetadata(meta, null))).toEqual({ feedUrl: "x" });
  });
  it("handles null/empty starting metadata", () => {
    expect(JSON.parse(setNoticeInMetadata(null, { message: "Hi" }))).toEqual({
      notice: { message: "Hi" },
    });
  });
});

describe("formatNoticePointer", () => {
  it("appends the coordinate when present", () => {
    expect(formatNoticePointer({ message: "Moved", coordinate: "cognition/devin" })).toBe(
      "Moved → cognition/devin",
    );
  });
  it("appends the href when no coordinate", () => {
    expect(formatNoticePointer({ message: "Moved", href: "https://devin.ai" })).toBe(
      "Moved → https://devin.ai",
    );
  });
  it("returns just the message when no pointer", () => {
    expect(formatNoticePointer({ message: "Heads up" })).toBe("Heads up");
  });
});
