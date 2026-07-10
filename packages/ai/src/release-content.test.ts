import { describe, expect, test } from "bun:test";
import {
  parseBreaking,
  parseImportance,
  parseReleaseContent,
  summarizeRelease,
  type SummarizeReleaseInput,
} from "./release-content";
import type { TextModel, TextModelRequest } from "./text-model";

/** A TextModel stub that records calls and returns canned text. */
function stubModel(text: string) {
  const calls: TextModelRequest[] = [];
  const model: TextModel = {
    id: "anthropic:claude-haiku-4-5",
    async complete(req) {
      calls.push(req);
      return { text, usage: { input: 10, output: 6, cacheCreate: 0, cacheRead: 0 } };
    },
  };
  return { model, calls };
}

/** Build a full, well-formed model response with the eight output tags. */
function response(opts: {
  empty?: boolean;
  title?: string;
  short?: string;
  summary?: string;
  breaking?: string;
  migration?: string;
  importance?: string;
}): string {
  return [
    `<empty>${opts.empty ? "true" : "false"}</empty>`,
    `<title>${opts.title ?? "Acme v2.0.0 removes the legacy client"}</title>`,
    `<title_short>${opts.short ?? "Legacy client removed"}</title_short>`,
    `<summary>${opts.summary ?? "The legacy client was removed."}</summary>`,
    `<composition><bugs>0</bugs><features>1</features><enhancements>0</enhancements></composition>`,
    `<breaking>${opts.breaking ?? "none"}</breaking>`,
    `<migration>${opts.migration ?? "none"}</migration>`,
    `<importance>${opts.importance ?? "3"}</importance>`,
  ].join("\n");
}

const INPUT: SummarizeReleaseInput = {
  orgSlug: "acme",
  sourceName: "Acme SDK",
  productName: null,
  title: "v2.0.0",
  version: "2.0.0",
  url: null,
  content: "### Breaking changes\n- removed the legacy client; use the new one.",
};

describe("parseBreaking", () => {
  test("major with explicit migration steps", () => {
    const r = parseBreaking(
      "<breaking>major</breaking><migration>Replace foo() with bar().</migration>",
    );
    expect(r.breaking).toBe("major");
    expect(r.migrationNotes).toBe("Replace foo() with bar().");
  });

  test("minor with no migration steps", () => {
    const r = parseBreaking("<breaking>minor</breaking><migration>none</migration>");
    expect(r.breaking).toBe("minor");
    expect(r.migrationNotes).toBeNull();
  });

  test("none / unknown drop any migration text", () => {
    expect(
      parseBreaking("<breaking>none</breaking><migration>x</migration>").migrationNotes,
    ).toBeNull();
    expect(
      parseBreaking("<breaking>unknown</breaking><migration>x</migration>").migrationNotes,
    ).toBeNull();
  });

  test("fail-open: garbled/missing <breaking> maps to unknown (never throws)", () => {
    expect(parseBreaking("no tags").breaking).toBe("unknown");
    expect(parseBreaking("<breaking>catastrophic</breaking>").breaking).toBe("unknown");
    expect(parseBreaking("<breaking></breaking>").breaking).toBe("unknown");
  });

  test("case-insensitive verdict; sentinel migration → null", () => {
    expect(parseBreaking("<breaking>MAJOR</breaking><migration>none</migration>").breaking).toBe(
      "major",
    );
    expect(
      parseBreaking("<breaking>major</breaking><migration>N/A</migration>").migrationNotes,
    ).toBeNull();
    expect(
      parseBreaking("<breaking>major</breaking><migration></migration>").migrationNotes,
    ).toBeNull();
  });
});

describe("parseImportance", () => {
  test("valid single digit 1-5", () => {
    expect(parseImportance("<importance>3</importance>")).toBe(3);
    expect(parseImportance("<importance>1</importance>")).toBe(1);
    expect(parseImportance("<importance>5</importance>")).toBe(5);
  });

  test("fail-open: missing tag maps to null", () => {
    expect(parseImportance("no tags")).toBeNull();
    expect(parseImportance("<importance></importance>")).toBeNull();
  });

  test("fail-open: out-of-range value maps to null", () => {
    expect(parseImportance("<importance>7</importance>")).toBeNull();
    expect(parseImportance("<importance>0</importance>")).toBeNull();
    expect(parseImportance("<importance>-1</importance>")).toBeNull();
  });

  test("fail-open: non-numeric value maps to null", () => {
    expect(parseImportance("<importance>high</importance>")).toBeNull();
    expect(parseImportance("<importance>3.5</importance>")).toBeNull();
  });
});

describe("parseReleaseContent breaking extraction", () => {
  test("extracts breaking + migration alongside title/summary", () => {
    const r = parseReleaseContent(
      response({ breaking: "major", migration: "Upgrade to Node 20." }),
      null,
    );
    expect(r.breaking).toBe("major");
    expect(r.migrationNotes).toBe("Upgrade to Node 20.");
    expect(r.summary).toBe("The legacy client was removed.");
  });

  test("fail-open: a response without breaking tags still parses, breaking=unknown", () => {
    const raw = [
      "<empty>false</empty>",
      "<title>Acme v1.2.0 adds a flag</title>",
      "<title_short>New flag added</title_short>",
      "<summary>Added a flag.</summary>",
      "<composition><bugs>0</bugs><features>1</features><enhancements>0</enhancements></composition>",
    ].join("\n");
    const r = parseReleaseContent(raw, null);
    expect(r.breaking).toBe("unknown");
    expect(r.migrationNotes).toBeNull();
    expect(r.summary).toBe("Added a flag.");
  });

  test("empty=true discards summary but still surfaces the breaking verdict", () => {
    const r = parseReleaseContent(response({ empty: true, breaking: "none" }), null);
    expect(r.summary).toBeNull(); // discarded
    expect(r.breaking).toBe("none");
  });
});

describe("parseReleaseContent importance extraction", () => {
  test("extracts a valid importance score alongside title/summary", () => {
    const r = parseReleaseContent(response({ importance: "4" }), null);
    expect(r.importance).toBe(4);
    expect(r.summary).toBe("The legacy client was removed.");
  });

  test("fail-open: a response without an importance tag still parses, importance=null", () => {
    const raw = [
      "<empty>false</empty>",
      "<title>Acme v1.2.0 adds a flag</title>",
      "<title_short>New flag added</title_short>",
      "<summary>Added a flag.</summary>",
      "<composition><bugs>0</bugs><features>1</features><enhancements>0</enhancements></composition>",
    ].join("\n");
    const r = parseReleaseContent(raw, null);
    expect(r.importance).toBeNull();
    expect(r.summary).toBe("Added a flag.");
  });

  test("fail-open: an out-of-range importance value maps to null", () => {
    const r = parseReleaseContent(response({ importance: "7" }), null);
    expect(r.importance).toBeNull();
  });

  test("fail-open: a non-numeric importance value maps to null", () => {
    const r = parseReleaseContent(response({ importance: "critical" }), null);
    expect(r.importance).toBeNull();
  });
});

describe("summarizeRelease breaking", () => {
  test("empty body short-circuits: breaking unknown, no model call", async () => {
    const { model, calls } = stubModel(response({ breaking: "major" }));
    const r = await summarizeRelease(model, { ...INPUT, content: "Updated dependencies" });
    expect(r.skipped).toBe(true);
    expect(r.breaking).toBe("unknown");
    expect(r.migrationNotes).toBeNull();
    expect(calls.length).toBe(0);
  });

  test("real body returns the breaking verdict from the single summarize call", async () => {
    const { model, calls } = stubModel(
      response({ breaking: "major", migration: "Switch to the new client." }),
    );
    const r = await summarizeRelease(model, INPUT);
    expect(r.skipped).toBe(false);
    expect(r.breaking).toBe("major");
    expect(r.migrationNotes).toBe("Switch to the new client.");
    expect(calls.length).toBe(1); // one call total — no separate classifier request
  });
});

describe("summarizeRelease importance", () => {
  test("empty body short-circuits: importance null, no model call", async () => {
    const { model, calls } = stubModel(response({ importance: "5" }));
    const r = await summarizeRelease(model, { ...INPUT, content: "Updated dependencies" });
    expect(r.skipped).toBe(true);
    expect(r.importance).toBeNull();
    expect(calls.length).toBe(0);
  });

  test("real body returns the importance score from the single summarize call", async () => {
    const { model } = stubModel(response({ importance: "5" }));
    const r = await summarizeRelease(model, INPUT);
    expect(r.skipped).toBe(false);
    expect(r.importance).toBe(5);
  });
});
