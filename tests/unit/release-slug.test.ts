import { describe, it, expect } from "bun:test";
import {
  parseReleaseParam,
  releasePath,
  releaseSlug,
} from "@buildinternet/releases-core/release-slug";

// 21-char nanoid body including the tricky alphabet members - and _
const BODY = "V1StGXR8_Z5jdHi6B-myT"; // exactly 21 chars, contains - and _
const REL = `rel_${BODY}`;

describe("releaseSlug", () => {
  it("prefers titleShort", () => {
    expect(
      releaseSlug({
        titleShort: "Claude Code 2.0 adds hooks",
        titleGenerated: "Something Else",
        title: "v2.0.0",
      }),
    ).toBe("claude-code-2-0-adds-hooks");
  });

  it("falls back titleShort -> titleGenerated -> title -> version", () => {
    expect(releaseSlug({ titleGenerated: "Gen Title" })).toBe("gen-title");
    expect(releaseSlug({ title: "Raw Title" })).toBe("raw-title");
    expect(releaseSlug({ version: "v2.3.1" })).toBe("v2-3-1");
  });

  it("skips empty/whitespace candidates in the chain", () => {
    expect(releaseSlug({ titleShort: "  ", title: "Real Title" })).toBe("real-title");
  });

  it("returns empty string when nothing usable", () => {
    expect(releaseSlug({})).toBe("");
    expect(releaseSlug({ title: "***" })).toBe("");
  });

  it("caps at 80 chars on a hyphen boundary", () => {
    const long = Array(30).fill("word").join(" "); // slug would be 149 chars
    const slug = releaseSlug({ title: long });
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug.endsWith("-")).toBe(false);
    expect(slug.startsWith("word-word")).toBe(true);
  });

  it("hard-cuts an 80+ char run with no hyphen", () => {
    const slug = releaseSlug({ title: "x".repeat(120) });
    expect(slug).toBe("x".repeat(80));
  });
});

describe("releasePath", () => {
  it("appends the slug after the id", () => {
    expect(releasePath({ id: REL, titleShort: "Hooks ship" })).toBe(`/release/${REL}-hooks-ship`);
  });

  it("emits the bare-id path when the slug is empty", () => {
    expect(releasePath({ id: REL })).toBe(`/release/${REL}`);
  });
});

describe("parseReleaseParam", () => {
  it("extracts id and slug positionally", () => {
    expect(parseReleaseParam(`${REL}-claude-code-2-0`)).toEqual({
      id: REL,
      slug: "claude-code-2-0",
    });
  });

  it("handles ids containing - and _ (nanoid alphabet)", () => {
    // The first 21 chars after rel_ are the id even though they contain hyphens.
    expect(parseReleaseParam(`${REL}-x`)).toEqual({ id: REL, slug: "x" });
  });

  it("returns bare id with null slug", () => {
    expect(parseReleaseParam(REL)).toEqual({ id: REL, slug: null });
  });

  it("passes through non-matching input unchanged (existing 404 path)", () => {
    expect(parseReleaseParam("rel_short")).toEqual({ id: "rel_short", slug: null });
    expect(parseReleaseParam("not-an-id")).toEqual({ id: "not-an-id", slug: null });
  });

  it("round-trips with releasePath", () => {
    const path = releasePath({ id: REL, titleShort: "Some Title Here" });
    const segment = path.slice("/release/".length);
    expect(parseReleaseParam(segment).id).toBe(REL);
  });

  it("is not fooled by a 21-char slug", () => {
    // Slug part happens to be 21 valid nanoid chars — id is still positional.
    const slug21 = "a".repeat(21);
    expect(parseReleaseParam(`${REL}-${slug21}`)).toEqual({ id: REL, slug: slug21 });
  });
});
