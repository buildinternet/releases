import { describe, expect, it } from "bun:test";
import { parseComposition, parseReleaseContent } from "@releases/ai-internal/release-content";
import { parseCompositionFromMetadata } from "@buildinternet/releases-core/composition";
import { buildCompositionMetadataSet } from "@releases/core-internal/composition-metadata";

const fullResponse = (compositionBlock: string) =>
  `<title>Foo v1.0 ships</title>
<title_short>Foo v1.0 ships</title_short>
<summary>Did some things.</summary>
${compositionBlock}`;

describe("parseComposition (AI model output)", () => {
  it("parses a well-formed composition tag", () => {
    const raw = fullResponse(
      "<composition><bugs>12</bugs><features>3</features><enhancements>1</enhancements></composition>",
    );
    expect(parseComposition(raw)).toEqual({ bugs: 12, features: 3, enhancements: 1 });
  });

  it("returns null when the tag is absent", () => {
    expect(parseComposition("<summary>x</summary>")).toBeNull();
  });

  it("returns null when any sub-tag is missing", () => {
    const raw = "<composition><bugs>1</bugs><features>2</features></composition>";
    expect(parseComposition(raw)).toBeNull();
  });

  it("returns null when all counts are zero (boilerplate case)", () => {
    const raw = fullResponse(
      "<composition><bugs>0</bugs><features>0</features><enhancements>0</enhancements></composition>",
    );
    expect(parseComposition(raw)).toBeNull();
  });

  it("returns null on non-integer or negative counts", () => {
    expect(
      parseComposition(
        "<composition><bugs>3.5</bugs><features>1</features><enhancements>0</enhancements></composition>",
      ),
    ).toBeNull();
    expect(
      parseComposition(
        "<composition><bugs>-1</bugs><features>1</features><enhancements>0</enhancements></composition>",
      ),
    ).toBeNull();
    expect(
      parseComposition(
        "<composition><bugs>oops</bugs><features>1</features><enhancements>0</enhancements></composition>",
      ),
    ).toBeNull();
  });

  it("threads through parseReleaseContent into the full result", () => {
    const raw = fullResponse(
      "<composition><bugs>2</bugs><features>1</features><enhancements>0</enhancements></composition>",
    );
    const result = parseReleaseContent(raw, "end_turn");
    expect(result.summary).toBe("Did some things.");
    expect(result.composition).toEqual({ bugs: 2, features: 1, enhancements: 0 });
  });

  it("returns composition=null in the full result when the tag is dropped", () => {
    const raw = `<title>x</title><title_short>x</title_short><summary>x</summary>`;
    const result = parseReleaseContent(raw, "end_turn");
    expect(result.composition).toBeNull();
  });
});

describe("parseReleaseContent boilerplate-fallback guard", () => {
  // Without these guards the bad output below leaks straight to the web UI
  // as a SUMMARY block that just says "no summary". See rel_dH8OlYQtxhCGYMXZt6dWx.
  it("nulls the summary when the model emits the EMPTY_BODY_FALLBACK sentinel", () => {
    const raw = `<title>Chrome 148 for Android stability and performance improvements</title>
<title_short>Dependency update</title_short>
<summary>Release notes do not describe the change.</summary>
<composition><bugs>0</bugs><features>0</features><enhancements>0</enhancements></composition>`;
    const result = parseReleaseContent(raw, "end_turn");
    expect(result.summary).toBeNull();
    expect(result.titleShort).toBeNull();
    expect(result.title).toBe("Chrome 148 for Android stability and performance improvements");
  });

  it("nulls 'Internal release' short title", () => {
    const raw = `<title>Claude Code v2.1.138 internal release</title>
<title_short>Internal release</title_short>
<summary>Release notes do not describe the change.</summary>`;
    const result = parseReleaseContent(raw, "end_turn");
    expect(result.titleShort).toBeNull();
    expect(result.summary).toBeNull();
  });

  it("matches the fallback strings case-insensitively and with whitespace", () => {
    const raw = `<title>X</title>
<title_short>  dependency update  </title_short>
<summary>  release notes DO NOT describe the change.  </summary>`;
    const result = parseReleaseContent(raw, "end_turn");
    expect(result.summary).toBeNull();
    expect(result.titleShort).toBeNull();
  });

  it("preserves real summaries that mention the word 'change'", () => {
    const raw = `<title>Foo v1 ships</title>
<title_short>Foo v1 ships</title_short>
<summary>Default behavior changes to opt-in. Release notes describe the migration path.</summary>`;
    const result = parseReleaseContent(raw, "end_turn");
    expect(result.summary).toBe(
      "Default behavior changes to opt-in. Release notes describe the migration path.",
    );
  });

  it("preserves a real short title that contains 'update'", () => {
    const raw = `<title>X</title>
<title_short>Auth middleware update breaks v1 callers</title_short>
<summary>Real summary.</summary>`;
    const result = parseReleaseContent(raw, "end_turn");
    expect(result.titleShort).toBe("Auth middleware update breaks v1 callers");
    expect(result.summary).toBe("Real summary.");
  });
});

describe("parseCompositionFromMetadata (DB read path)", () => {
  it("extracts a stored composition object", () => {
    const meta = JSON.stringify({ composition: { bugs: 5, features: 2, enhancements: 1 } });
    expect(parseCompositionFromMetadata(meta)).toEqual({
      bugs: 5,
      features: 2,
      enhancements: 1,
    });
  });

  it("returns null for null / empty / non-JSON inputs", () => {
    expect(parseCompositionFromMetadata(null)).toBeNull();
    expect(parseCompositionFromMetadata("")).toBeNull();
    expect(parseCompositionFromMetadata("not json")).toBeNull();
  });

  it("returns null when composition slot is missing or JSON null", () => {
    expect(parseCompositionFromMetadata("{}")).toBeNull();
    expect(parseCompositionFromMetadata('{"composition": null}')).toBeNull();
  });

  it("returns null when counts are malformed", () => {
    expect(
      parseCompositionFromMetadata(JSON.stringify({ composition: { bugs: 1, features: 2 } })),
    ).toBeNull();
    expect(
      parseCompositionFromMetadata(
        JSON.stringify({ composition: { bugs: "1", features: 2, enhancements: 3 } }),
      ),
    ).toBeNull();
    expect(
      parseCompositionFromMetadata(
        JSON.stringify({ composition: { bugs: -1, features: 0, enhancements: 0 } }),
      ),
    ).toBeNull();
  });

  it("returns null when all counts are zero", () => {
    expect(
      parseCompositionFromMetadata(
        JSON.stringify({ composition: { bugs: 0, features: 0, enhancements: 0 } }),
      ),
    ).toBeNull();
  });

  it("ignores unrelated metadata keys", () => {
    const meta = JSON.stringify({
      crawlEnabled: true,
      composition: { bugs: 1, features: 0, enhancements: 0 },
    });
    expect(parseCompositionFromMetadata(meta)).toEqual({
      bugs: 1,
      features: 0,
      enhancements: 0,
    });
  });
});

describe("buildCompositionMetadataSet (write helper)", () => {
  // Drizzle SQL fragments expose their string segments on `.queryChunks` —
  // sniff those to verify the generated SQL without needing a live dialect.
  const chunkText = (frag: ReturnType<typeof buildCompositionMetadataSet>): string => {
    if (!frag) return "";
    const chunks = (frag as unknown as { queryChunks: unknown[] }).queryChunks;
    return chunks
      .map((c) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object" && "value" in c)
          return String((c as { value: unknown }).value);
        return "";
      })
      .join(" ");
  };

  it("returns null for undefined — caller skips touching metadata", () => {
    expect(buildCompositionMetadataSet(undefined)).toBeNull();
  });

  it("returns a CASE+json_remove fragment for null that preserves NULL metadata", () => {
    const frag = buildCompositionMetadataSet(null);
    const text = chunkText(frag);
    // NULL metadata stays NULL — only non-NULL rows get json_remove applied.
    expect(text).toContain("CASE");
    expect(text).toContain("IS NULL");
    expect(text).toContain("json_remove");
    expect(text).toContain("$.composition");
  });

  it("returns a json_set fragment for an object", () => {
    const frag = buildCompositionMetadataSet({ bugs: 1, features: 2, enhancements: 0 });
    const text = chunkText(frag);
    expect(text).toContain("json_set");
    expect(text).toContain('"bugs":1');
    expect(text).toContain('"features":2');
    expect(text).toContain('"enhancements":0');
  });
});
