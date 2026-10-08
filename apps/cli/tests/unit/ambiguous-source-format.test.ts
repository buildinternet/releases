import { describe, it, expect } from "bun:test";
import { AmbiguousSourceError } from "../../src/api/sources.js";
import { formatAmbiguousSourceError, describeAmbiguousSource } from "../../src/cli/suggest.js";
import { stripAnsi } from "../../src/lib/sanitize.js";

describe("formatAmbiguousSourceError (#264)", () => {
  const err = new AmbiguousSourceError("blog", [
    { id: "src_PWoiFLRKVUrpO1cgRYpQX", slug: "blog", orgSlug: "vitest" },
    { id: "src_9kLm2QvTbZ", slug: "blog", orgSlug: "hashnode" },
  ]);

  it("names the ambiguous slug and the match count", () => {
    const out = stripAnsi(formatAmbiguousSourceError(err));
    expect(out).toContain('"blog"');
    expect(out).toContain("2");
    expect(out.toLowerCase()).toContain("ambiguous");
  });

  it("lists each candidate as org/slug alongside its src_ id", () => {
    const out = stripAnsi(formatAmbiguousSourceError(err));
    expect(out).toContain("vitest/blog");
    expect(out).toContain("src_PWoiFLRKVUrpO1cgRYpQX");
    expect(out).toContain("hashnode/blog");
    expect(out).toContain("src_9kLm2QvTbZ");
  });

  it("tells the operator how to disambiguate", () => {
    const out = stripAnsi(formatAmbiguousSourceError(err)).toLowerCase();
    expect(out).toContain("org/slug");
    expect(out).toContain("src_");
  });
});

describe("describeAmbiguousSource — plain text for MCP/non-TTY surfaces (#264)", () => {
  const err = new AmbiguousSourceError("blog", [
    { id: "src_PWoiFLRKVUrpO1cgRYpQX", slug: "blog", orgSlug: "vitest" },
    { id: "src_9kLm2QvTbZ", slug: "blog", orgSlug: "hashnode" },
  ]);

  it("emits no ANSI escape codes", () => {
    const out = describeAmbiguousSource(err);
    expect(out).toBe(stripAnsi(out));
  });

  it("names the slug, the count, and lists each candidate with its src_ id", () => {
    const out = describeAmbiguousSource(err);
    expect(out).toContain('"blog"');
    expect(out).toContain("2");
    expect(out.toLowerCase()).toContain("ambiguous");
    expect(out).toContain("vitest/blog");
    expect(out).toContain("src_PWoiFLRKVUrpO1cgRYpQX");
    expect(out).toContain("hashnode/blog");
    expect(out).toContain("src_9kLm2QvTbZ");
  });

  it("points at the org/slug + src_ disambiguators", () => {
    const out = describeAmbiguousSource(err).toLowerCase();
    expect(out).toContain("org/slug");
    expect(out).toContain("src_");
  });
});
