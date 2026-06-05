import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fieldEvidence, materializeViewerWorkspace, type ViewerCase } from "./viewer";
import type { FieldResult } from "./helpers";

describe("fieldEvidence", () => {
  it("reports the actual value on pass", () => {
    const f: FieldResult = { field: "x", passed: true, expected: "clean", actual: "clean" };
    expect(fieldEvidence(f)).toBe("ok — clean");
  });

  it("reports expected vs actual on fail, stringifying non-strings", () => {
    const f: FieldResult = { field: "len", passed: false, expected: "<= 120", actual: 200 };
    expect(fieldEvidence(f)).toBe("expected <= 120, got 200");
  });
});

describe("materializeViewerWorkspace", () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("writes the skill-creator eval-viewer directory shape per case", () => {
    const root = mkdtempSync(join(tmpdir(), "viewer-test-"));
    dirs.push(root);

    const cases: ViewerCase[] = [
      {
        name: "alpha",
        prompt: "Do the alpha thing.",
        outputName: "overview.md",
        body: "# alpha body",
        fields: [
          { field: "non-empty", passed: true, expected: "non-empty", actual: "non-empty" },
          { field: "word count", passed: false, expected: "80–300", actual: 4 },
        ],
      },
    ];

    materializeViewerWorkspace(root, cases);

    const caseDir = join(root, "eval-alpha");
    expect(existsSync(join(caseDir, "outputs", "overview.md"))).toBe(true);
    expect(readFileSync(join(caseDir, "outputs", "overview.md"), "utf8")).toBe("# alpha body");

    const meta = JSON.parse(readFileSync(join(caseDir, "eval_metadata.json"), "utf8"));
    expect(meta).toEqual({ eval_id: 0, eval_name: "alpha", prompt: "Do the alpha thing." });

    const grading = JSON.parse(readFileSync(join(caseDir, "grading.json"), "utf8"));
    expect(grading.summary).toEqual({ passed: 1, failed: 1, total: 2, pass_rate: 0.5 });
    expect(grading.expectations).toEqual([
      { text: "non-empty", passed: true, evidence: "ok — non-empty" },
      { text: "word count", passed: false, evidence: "expected 80–300, got 4" },
    ]);
  });
});
