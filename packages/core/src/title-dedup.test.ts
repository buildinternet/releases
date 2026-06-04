import { describe, it, expect } from "bun:test";
import { normalizeTitleKey, dedupeByExistingTitle } from "./title-dedup.js";

describe("normalizeTitleKey", () => {
  it("lowercases + collapses whitespace + trims", () => {
    expect(normalizeTitleKey("  Numeric  Field   Updates ")).toBe("numeric field updates");
    expect(normalizeTitleKey("Numeric field updates")).toBe(
      normalizeTitleKey("numeric FIELD updates"),
    );
    expect(normalizeTitleKey("a\tb\nc")).toBe("a b c");
  });

  it("does not merge genuinely different titles (conservative)", () => {
    expect(normalizeTitleKey("Bug fixes")).not.toBe(normalizeTitleKey("Bug fixes and more"));
    expect(normalizeTitleKey("Foo: bar")).not.toBe(normalizeTitleKey("Foo bar")); // punctuation kept
  });
});

describe("dedupeByExistingTitle", () => {
  it("drops items whose normalized title already exists (the backfill-vs-cron case)", () => {
    // Existing backfill row anchored as #may-2026; cron re-extracts the same entry
    // with a #slug(title) anchor but the SAME title → must be dropped.
    const existing = [normalizeTitleKey("Numeric field type updates")];
    const incoming = [
      { title: "Numeric field type updates", url: "https://x/p#numeric-field-type-updates" },
      { title: "Call skip codes", url: "https://x/p#call-skip-codes" },
    ];
    const { kept, dropped } = dedupeByExistingTitle(incoming, existing);
    expect(dropped).toBe(1);
    expect(kept.map((r) => r.title)).toEqual(["Call skip codes"]);
  });

  it("tolerates trivial case/whitespace rewording", () => {
    const { kept, dropped } = dedupeByExistingTitle(
      [{ title: "numeric   field  TYPE updates" }],
      [normalizeTitleKey("Numeric field type updates")],
    );
    expect(dropped).toBe(1);
    expect(kept).toHaveLength(0);
  });

  it("dedups within the same batch", () => {
    const { kept, dropped } = dedupeByExistingTitle(
      [{ title: "Same" }, { title: "same" }, { title: "Other" }],
      [],
    );
    expect(dropped).toBe(1);
    expect(kept.map((r) => r.title)).toEqual(["Same", "Other"]);
  });

  it("keeps a same-title item whose URL already exists (URL path handles it)", () => {
    // A same-row re-fetch (identical url) must NOT be pre-dropped — the
    // UNIQUE(source_id,url) upsert/conflict path owns it; pre-dropping would skew
    // that path's found/inserted accounting.
    const { kept, dropped } = dedupeByExistingTitle(
      [{ title: "Release A", url: "https://x/a" }],
      [normalizeTitleKey("Release A")],
      ["https://x/a"],
    );
    expect(dropped).toBe(0);
    expect(kept).toHaveLength(1);
  });

  it("drops a same-title item under a NEW url even when an existing url is known", () => {
    const { kept, dropped } = dedupeByExistingTitle(
      [{ title: "Release A", url: "https://x/a#new-anchor" }],
      [normalizeTitleKey("Release A")],
      ["https://x/a#may-2026"],
    );
    expect(dropped).toBe(1);
    expect(kept).toHaveLength(0);
  });

  it("keeps items with no usable title (can't match)", () => {
    const { kept, dropped } = dedupeByExistingTitle(
      [{ title: "" }, { title: null }, { title: "   " }, {}],
      ["something"],
    );
    expect(dropped).toBe(0);
    expect(kept).toHaveLength(4);
  });

  it("passes everything through against an empty existing set + distinct titles", () => {
    const incoming = [{ title: "A" }, { title: "B" }, { title: "C" }];
    const { kept, dropped } = dedupeByExistingTitle(incoming, []);
    expect(dropped).toBe(0);
    expect(kept).toHaveLength(3);
  });
});
