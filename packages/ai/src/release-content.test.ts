import { describe, expect, test } from "bun:test";
import {
  parseBreaking,
  parseImportance,
  lintReleaseContent,
  parseReleaseContent,
  summarizeRelease,
  type SummarizeReleaseInput,
} from "./release-content";
import type { TextModel, TextModelRequest } from "./text-model";

/** A TextModel stub that records calls and returns canned text. */
function stubModel(text: string) {
  const calls: TextModelRequest[] = [];
  const model: TextModel = {
    id: "anthropic:claude-haiku-5-5",
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
  test("App Store filler short-circuits: no model call", async () => {
    const { model, calls } = stubModel(response({ breaking: "major" }));
    for (const content of [
      "Bug fixes and performance improvements.",
      "This update includes bug fixes and performance improvements.",
      "No specific changes in this version.",
    ]) {
      const r = await summarizeRelease(model, { ...INPUT, content });
      expect(r.skipped).toBe(true);
      expect(r.title).toBeNull();
      expect(r.summary).toBeNull();
    }
    expect(calls.length).toBe(0);
  });

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

describe("lintReleaseContent", () => {
  const clean = {
    title: "Datadog Agent 7.85.0 requires Oracle client 19c or newer",
    titleShort: "Oracle checks now need client 19c or newer",
    summary:
      "Oracle integration checks now require an external Oracle client 19c or newer. Older clients fail at startup.",
  };

  test("passes clean output, including product names that contain the org", () => {
    expect(lintReleaseContent(clean, "datadog")).toEqual([]);
  });

  test("flags the tells from the Datadog feedback", () => {
    const v = lintReleaseContent(
      {
        title: "Datadog says Bits investigations now cost 84% less and run 82% faster",
        titleShort: "Bits investigations: 84% cheaper, 82% faster",
        summary:
          "Datadog details AI Guard, which blocks prompts. It offers crash handlers, C++17 and C99 APIs, CMake support, FFI bindings, and consent controls. Also fixed falcon.asgi.App creation.",
      },
      "datadog",
    );
    expect(v).toContain("title-org-narrator");
    expect(v).toContain("short-colon-headline");
    expect(v).toContain("summary-org-subject");
    expect(v).toContain("summary-comma-stack");
    expect(v).toContain("summary-fragment");
  });

  test("org as short-title subject, multi-word org slugs, em dashes", () => {
    expect(
      lintReleaseContent({ ...clean, titleShort: "Datadog adds prompt registry" }, "datadog"),
    ).toContain("short-org-subject");
    expect(
      lintReleaseContent(
        { ...clean, titleShort: "Vercel Labs ships agent toolkit" },
        "vercel-labs",
      ),
    ).toContain("short-org-subject");
    expect(
      lintReleaseContent({ ...clean, summary: "Caching is on by default — no opt-in." }, "acme"),
    ).toContain("em-dash");
  });

  test("thousands separators are not list commas", () => {
    expect(
      lintReleaseContent(
        { ...clean, summary: "Limits rose from 1,000 to 10,000, then 100,000 and 1,000,000 rows." },
        "acme",
      ),
    ).toEqual([]);
  });
});

describe("summarizeRelease style retry", () => {
  function sequenceModel(texts: string[]) {
    const calls: TextModelRequest[] = [];
    const model: TextModel = {
      id: "anthropic:claude-haiku-5-5",
      async complete(req) {
        calls.push(req);
        const text = texts[Math.min(calls.length - 1, texts.length - 1)];
        return { text, usage: { input: 10, output: 6, cacheCreate: 0, cacheRead: 0 } };
      },
    };
    return { model, calls };
  }

  test("a clean draft makes one call", async () => {
    const { model, calls } = sequenceModel([response({})]);
    await summarizeRelease(model, INPUT);
    expect(calls.length).toBe(1);
  });

  test("a machine-sounding draft is rewritten once and the better answer kept", async () => {
    const { model, calls } = sequenceModel([
      response({ summary: "Acme details the new client. Also removed the legacy one." }),
      response({ summary: "The new client replaces the legacy one, which was removed." }),
    ]);
    const r = await summarizeRelease(model, INPUT);
    expect(calls.length).toBe(2);
    expect(calls[1].user).toContain("makes the org the subject");
    expect(r.summary).toBe("The new client replaces the legacy one, which was removed.");
    expect(r.usage.input).toBe(20);
  });

  test("a retry that is no better keeps the first draft", async () => {
    const draft = "Acme details the new client.";
    const { model, calls } = sequenceModel([
      response({ summary: draft }),
      response({ summary: "Acme explains the new client." }),
    ]);
    const r = await summarizeRelease(model, INPUT);
    expect(calls.length).toBe(2);
    expect(r.summary).toBe(draft);
  });
});
