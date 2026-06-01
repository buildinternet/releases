/**
 * Prep step for the KEY-FREE sub-agent marketing eval (see SUBAGENT-EVALS.md).
 *
 * The sub-agent orchestration runs in a Claude Code Workflow
 * (.claude/workflows/eval-marketing-subagents.ts) whose sandbox cannot touch the
 * filesystem or import repo code. So the one repo-coupled half — composing the
 * exact production system prompt + per-fixture user message — lives here. It
 * writes one composed prompt file per fixture to a temp dir and prints a small
 * manifest (id, expected label, file path) that becomes the Workflow's `args`.
 *
 *   bun tests/evals/subagent-runner.ts prep marketing
 *     -> writes <tmp>/releases-subagent-eval/marketing/<id>.txt
 *     -> prints { floor, maxFalsePositives, cases: [{ id, expected, file }] } to stdout
 *
 * Grading mirrors tests/evals/graders.ts gradeBinary and lives inline in the
 * Workflow (the sandbox can't import graders.ts); the thresholds below are the
 * single source those two places agree on.
 */
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  SYSTEM_PROMPT,
  buildClassifierInput,
  MODEL,
  type MarketingClassifierInput,
} from "@releases/ai-internal/marketing-classifier";
import { saveRun } from "./results";

export const ACCURACY_FLOOR = 0.85;
export const MAX_FALSE_POSITIVES = 0;

interface MarketingFixture {
  id: string;
  input: MarketingClassifierInput;
  expected: { isMarketing: boolean; reason?: string };
}

function prepMarketing() {
  const fixtures = JSON.parse(
    readFileSync(join(import.meta.dir, "fixtures", "marketing", "cases.json"), "utf8"),
  ) as MarketingFixture[];

  const outDir = join(tmpdir(), "releases-subagent-eval", "marketing");
  mkdirSync(outDir, { recursive: true });

  const cases = fixtures.map((f) => {
    const composed = `${SYSTEM_PROMPT}\n\n---\nClassify this item:\n\n${buildClassifierInput(f.input)}`;
    const file = join(outDir, `${f.id}.txt`);
    writeFileSync(file, composed);
    return { id: f.id, expected: f.expected.isMarketing, file };
  });

  process.stdout.write(
    JSON.stringify({ floor: ACCURACY_FLOOR, maxFalsePositives: MAX_FALSE_POSITIVES, cases }),
  );
}

/**
 * Persist a Workflow result (the JSON the eval-marketing-subagents Workflow
 * returns) into the shared results dir, alongside the bun evals.
 */
function saveSubagentResult(resultPath: string) {
  const r = JSON.parse(readFileSync(resultPath, "utf8")) as {
    pass: boolean;
    accuracy: number;
    correct: number;
    total: number;
    falsePositives: number;
    falseNegatives: number;
    gate?: unknown;
    perCase?: unknown[];
  };
  const file = saveRun({
    eval: "marketing-subagent",
    model: MODEL,
    pass: r.pass,
    summary: {
      accuracy: r.accuracy,
      correct: r.correct,
      total: r.total,
      falsePositives: r.falsePositives,
      falseNegatives: r.falseNegatives,
      gate: r.gate ?? null,
    },
    cases: r.perCase ?? [],
  });
  console.error(`results: ${file}`);
}

const [cmd, kind, arg] = process.argv.slice(2);
if (cmd === "prep" && kind === "marketing") {
  prepMarketing();
} else if (cmd === "save" && kind === "marketing") {
  if (!arg) {
    console.error("usage: subagent-runner.ts save marketing <workflow-result.json>");
    process.exit(2);
  }
  saveSubagentResult(arg);
} else {
  console.error("usage: subagent-runner.ts <prep|save> marketing [workflow-result.json]");
  process.exit(2);
}
