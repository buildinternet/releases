import { describe, expect, test } from "bun:test";
import {
  buildBreakingBlock,
  parseBreaking,
  classifyBreaking,
  MAX_BODY_CHARS,
  type BreakingClassifyInput,
} from "./breaking-classifier";
import type { TextModel, TextModelRequest } from "./text-model";

/** A TextModel stub that records calls and returns canned text. */
function stubModel(text: string) {
  const calls: TextModelRequest[] = [];
  const model: TextModel = {
    id: "anthropic:claude-haiku-4-5",
    async complete(req) {
      calls.push(req);
      return { text, usage: { input: 12, output: 4, cacheCreate: 0, cacheRead: 0 } };
    },
  };
  return { model, calls };
}

/** A TextModel stub that throws — models a transport error. */
function throwingModel() {
  let called = 0;
  const model: TextModel = {
    id: "anthropic:claude-haiku-4-5",
    async complete() {
      called++;
      throw new Error("upstream 529");
    },
  };
  return {
    model,
    get called() {
      return called;
    },
  };
}

const INPUT: BreakingClassifyInput = {
  sourceName: "OpenAI Node SDK",
  productName: null,
  title: "v5.0.0",
  version: "5.0.0",
  content: "### Breaking changes\n- removed completions.create; use chat.completions.create",
};

describe("buildBreakingBlock", () => {
  test("renders source, title, version, and body", () => {
    const block = buildBreakingBlock(INPUT);
    expect(block).toContain("Source: OpenAI Node SDK");
    expect(block).toContain("Title: v5.0.0");
    expect(block).toContain("Version: 5.0.0");
    expect(block).toContain("Body:");
    expect(block).toContain("removed completions.create");
  });

  test("omits the Product line when product equals (or is absent vs.) source", () => {
    const block = buildBreakingBlock({ ...INPUT, productName: "OpenAI Node SDK" });
    expect(block).not.toContain("Product:");
  });

  test("includes a distinct Product line when set and different", () => {
    const block = buildBreakingBlock({ ...INPUT, productName: "Realtime" });
    expect(block).toContain("Product: Realtime");
  });

  test("truncates a body longer than MAX_BODY_CHARS", () => {
    const block = buildBreakingBlock({ ...INPUT, content: "x".repeat(MAX_BODY_CHARS + 500) });
    expect(block).toContain("[truncated]");
    expect(block.length).toBeLessThan(MAX_BODY_CHARS + 500);
  });
});

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

  test("none drops any migration text", () => {
    const r = parseBreaking("<breaking>none</breaking><migration>irrelevant</migration>");
    expect(r.breaking).toBe("none");
    expect(r.migrationNotes).toBeNull();
  });

  test("explicit unknown verdict carries no migration", () => {
    const r = parseBreaking("<breaking>unknown</breaking><migration>none</migration>");
    expect(r.breaking).toBe("unknown");
    expect(r.migrationNotes).toBeNull();
  });

  test("fail-open: garbled/missing <breaking> tag maps to unknown (never throws)", () => {
    expect(parseBreaking("no tags here").breaking).toBe("unknown");
    expect(parseBreaking("<breaking>catastrophic</breaking>").breaking).toBe("unknown");
    expect(parseBreaking("").breaking).toBe("unknown");
    expect(parseBreaking("<breaking></breaking>").breaking).toBe("unknown");
  });

  test("fail-open: a real verdict but empty/sentinel migration → null", () => {
    expect(
      parseBreaking("<breaking>major</breaking><migration></migration>").migrationNotes,
    ).toBeNull();
    expect(
      parseBreaking("<breaking>major</breaking><migration>N/A</migration>").migrationNotes,
    ).toBeNull();
  });

  test("is case-insensitive on the verdict value", () => {
    expect(parseBreaking("<breaking>MAJOR</breaking><migration>none</migration>").breaking).toBe(
      "major",
    );
  });
});

describe("classifyBreaking", () => {
  test("empty / boilerplate body short-circuits to unknown with NO model call", async () => {
    const { model, calls } = stubModel("<breaking>major</breaking>");
    const r = await classifyBreaking(model, { ...INPUT, content: "Updated dependencies" });
    expect(r.skipped).toBe(true);
    expect(r.breaking).toBe("unknown");
    expect(r.migrationNotes).toBeNull();
    expect(r.usage).toEqual({ input: 0, output: 0, cacheCreate: 0, cacheRead: 0 });
    expect(calls.length).toBe(0);
  });

  test("real body is classified via the model and parsed", async () => {
    const { model, calls } = stubModel(
      "<breaking>major</breaking><migration>Upgrade to Node 20.</migration>",
    );
    const r = await classifyBreaking(model, INPUT);
    expect(r.skipped).toBe(false);
    expect(r.breaking).toBe("major");
    expect(r.migrationNotes).toBe("Upgrade to Node 20.");
    expect(calls.length).toBe(1);
    expect(calls[0].cacheSystem).toBe(true);
  });

  test("unparseable model output fails open to unknown without throwing", async () => {
    const { model } = stubModel("the model rambled and emitted no tags");
    const r = await classifyBreaking(model, INPUT);
    expect(r.breaking).toBe("unknown");
    expect(r.migrationNotes).toBeNull();
    expect(r.skipped).toBe(false);
  });

  test("a transport error propagates (caller fails open)", async () => {
    const t = throwingModel();
    let threw = false;
    try {
      await classifyBreaking(t.model, INPUT);
    } catch (err) {
      threw = true;
      expect((err as Error).message).toContain("upstream 529");
    }
    expect(threw).toBe(true);
    expect(t.called).toBe(1);
  });
});
