import { describe, it, expect } from "bun:test";
import { unescapeHtmlEntities } from "../../src/cli/commands/admin/overview/unescape-html.js";

describe("unescapeHtmlEntities", () => {
  it("decodes &amp;", () => {
    expect(unescapeHtmlEntities("foo &amp; bar")).toBe("foo & bar");
  });

  it("decodes &lt;", () => {
    expect(unescapeHtmlEntities("a &lt; b")).toBe("a < b");
  });

  it("decodes &gt;", () => {
    expect(unescapeHtmlEntities("a &gt; b")).toBe("a > b");
  });

  it("decodes &quot;", () => {
    expect(unescapeHtmlEntities("say &quot;hello&quot;")).toBe('say "hello"');
  });

  it("decodes &#39;", () => {
    expect(unescapeHtmlEntities("it&#39;s")).toBe("it's");
  });

  it("decodes mixed entities in one pass", () => {
    expect(unescapeHtmlEntities("(string &amp; {}) &lt;T&gt;")).toBe("(string & {}) <T>");
  });

  it("&amp;lt; decodes to &lt;, not < (single-pass: amp → & leaving literal &lt;)", () => {
    // Single-pass regex: &amp; → & in one match, leaving &lt; untouched in that same pass.
    expect(unescapeHtmlEntities("&amp;lt;")).toBe("&lt;");
  });

  it("is idempotent on already-decoded strings", () => {
    expect(unescapeHtmlEntities("foo & bar")).toBe("foo & bar");
  });

  it("leaves unrelated text unchanged", () => {
    expect(unescapeHtmlEntities("hello world")).toBe("hello world");
  });

  // Always-on decode safety (#229): the decode now runs on every `overview
  // update`, so a body that's already clean — e.g. a caller that pre-decoded
  // and computed citation offsets against the decoded text — must come through
  // untouched, or those offsets would shift.
  it("leaves a realistic already-decoded overview body untouched", () => {
    const body = [
      "## What's new",
      "",
      "Shipped `streams.input<T>` and a Q&A panel.",
      'The flag is `"strict"` and it\'s on by default; use `a < b` checks.',
    ].join("\n");
    expect(unescapeHtmlEntities(body)).toBe(body);
  });

  it("is a no-op when applied twice (re-applying decode never shifts a clean body)", () => {
    const escaped = "Q&amp;A on streams.input&lt;T&gt;";
    const once = unescapeHtmlEntities(escaped);
    expect(unescapeHtmlEntities(once)).toBe(once);
  });
});
