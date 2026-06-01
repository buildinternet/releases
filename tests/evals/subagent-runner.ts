/**
 * Prep + persist steps for the KEY-FREE sub-agent evals (see SUBAGENT-EVALS.md).
 *
 * The sub-agent orchestration runs in Claude Code Workflows
 * (.claude/workflows/eval-{marketing,summary}-subagents.ts) whose sandbox cannot
 * touch the filesystem or import repo code. So the repo-coupled halves —
 * composing the exact production prompt per fixture, and the grading config —
 * live here. Prep writes one composed prompt file per fixture to a temp dir and
 * prints a small manifest that becomes the Workflow's `args`; the spawned
 * sub-agents (which DO have Read access) read those files by path.
 *
 *   bun tests/evals/subagent-runner.ts prep marketing
 *   bun tests/evals/subagent-runner.ts prep summary [--judge]
 *     -> writes <tmp>/releases-subagent-eval/<kind>/<id>.txt (+ .body.txt for judge)
 *     -> prints the manifest JSON to stdout
 *
 *   bun tests/evals/subagent-runner.ts save <marketing|summary> <result.json>
 *     -> persists the Workflow's returned JSON into tests/evals/results/
 *
 * Grading mirrors tests/evals/graders.ts (gradeBinary / gradeStructural) and
 * lives inline in each Workflow (the sandbox can't import graders.ts); the
 * thresholds + forbidden-token lists below are the single source those two
 * places agree on.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import {
  SYSTEM_PROMPT as MARKETING_SYSTEM_PROMPT,
  buildClassifierInput,
  MODEL as MARKETING_MODEL,
  type MarketingClassifierInput,
} from "@releases/ai-internal/marketing-classifier";
import {
  SYSTEM_PROMPT as SUMMARY_SYSTEM_PROMPT,
  buildReleaseBlock,
  isEmptyContent,
  EMPTY_BODY_FALLBACK,
  MODEL as SUMMARY_MODEL,
  type SummarizeReleaseInput,
} from "@releases/ai-internal/release-content";
import { DEFAULT_FORBIDDEN_SUBSTRINGS, type StructuralSpec } from "./graders";
import { saveRun } from "./results";

export const ACCURACY_FLOOR = 0.85;
export const MAX_FALSE_POSITIVES = 0;
// Matches TITLE_SHORT_MAX_CHARS in release-summary.eval.ts.
const TITLE_SHORT_MAX_CHARS = 120;

interface MarketingFixture {
  id: string;
  input: MarketingClassifierInput;
  expected: { isMarketing: boolean; reason?: string };
}

interface SummaryFixture {
  name: string;
  input: SummarizeReleaseInput;
  spec: StructuralSpec;
}

function prepMarketing() {
  const fixtures = JSON.parse(
    readFileSync(join(import.meta.dir, "fixtures", "marketing", "cases.json"), "utf8"),
  ) as MarketingFixture[];

  const outDir = join(tmpdir(), "releases-subagent-eval", "marketing");
  mkdirSync(outDir, { recursive: true });

  const cases = fixtures.map((f) => {
    const composed = `${MARKETING_SYSTEM_PROMPT}\n\n---\nClassify this item:\n\n${buildClassifierInput(f.input)}`;
    const file = join(outDir, `${f.id}.txt`);
    writeFileSync(file, composed);
    return { id: f.id, expected: f.expected.isMarketing, file };
  });

  process.stdout.write(
    JSON.stringify({ floor: ACCURACY_FLOOR, maxFalsePositives: MAX_FALSE_POSITIVES, cases }),
  );
}

function loadSummaryFixtures(dir: string): SummaryFixture[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((mdFile) => {
      const name = basename(mdFile, ".md");
      const meta = JSON.parse(readFileSync(join(dir, `${name}.expected.json`), "utf8")) as {
        input: Omit<SummarizeReleaseInput, "content">;
        spec: StructuralSpec;
      };
      const content = readFileSync(join(dir, mdFile), "utf8");
      return { name, input: { ...meta.input, content }, spec: meta.spec };
    });
}

function prepSummary(useJudge: boolean) {
  const dir = join(import.meta.dir, "fixtures", "summaries");
  const fixtures = loadSummaryFixtures(dir);

  const outDir = join(tmpdir(), "releases-subagent-eval", "summary");
  mkdirSync(outDir, { recursive: true });

  // Absolute path to the Tier-2 rubric; the judge sub-agent reads it directly.
  const rubricFile = useJudge
    ? join(import.meta.dir, "..", "..", "src", "shared", "rubrics", "release-summary.md")
    : null;

  const cases = fixtures.map((f) => {
    const composed = `${SUMMARY_SYSTEM_PROMPT}\n\n---\nSummarize this release:\n\n${buildReleaseBlock(f.input)}`;
    const promptFile = join(outDir, `${f.name}.txt`);
    writeFileSync(promptFile, composed);

    let bodyFile: string | null = null;
    if (useJudge && !f.spec.expectDiscarded) {
      bodyFile = join(outDir, `${f.name}.body.txt`);
      writeFileSync(bodyFile, f.input.content);
    }

    // Same forbidden-token set the metered eval feeds gradeStructural:
    // structural defaults + the empty-body sentinel + any per-fixture tokens.
    const forbidden = [
      ...DEFAULT_FORBIDDEN_SUBSTRINGS,
      EMPTY_BODY_FALLBACK,
      ...(f.spec.forbidInSummary ?? []),
    ];

    return {
      id: f.name,
      promptFile,
      bodyFile,
      // isEmptyContent short-circuits the model in production (all-null fields);
      // mirror that here so the Workflow skips the sub-agent for these.
      shortCircuit: isEmptyContent(f.input.content),
      spec: {
        expectDiscarded: f.spec.expectDiscarded,
        summaryMustBeNonEmpty: f.spec.summaryMustBeNonEmpty ?? true,
      },
      forbidden,
    };
  });

  process.stdout.write(
    JSON.stringify({
      kind: "summary",
      judge: useJudge,
      titleShortMaxChars: TITLE_SHORT_MAX_CHARS,
      emptyBodyFallback: EMPTY_BODY_FALLBACK,
      rubricFile,
      cases,
    }),
  );
}

/**
 * Persist a Workflow result (the JSON a sub-agent eval Workflow returns) into
 * the shared results dir, alongside the metered bun evals. Marketing and
 * summary return different aggregate shapes, so the `summary` field is passed
 * through verbatim minus the per-case list.
 */
function saveSubagentResult(kind: "marketing" | "summary", resultPath: string) {
  const r = JSON.parse(readFileSync(resultPath, "utf8")) as Record<string, unknown> & {
    pass: boolean;
    perCase?: unknown[];
  };
  const { perCase, ...aggregate } = r;
  const file = saveRun({
    eval: `${kind}-subagent`,
    model: kind === "marketing" ? MARKETING_MODEL : SUMMARY_MODEL,
    pass: r.pass,
    summary: aggregate,
    cases: (perCase as unknown[]) ?? [],
  });
  console.error(`results: ${file}`);
}

const [cmd, kind, arg] = process.argv.slice(2);
const useJudge = process.argv.includes("--judge");

if (cmd === "prep" && kind === "marketing") {
  prepMarketing();
} else if (cmd === "prep" && kind === "summary") {
  prepSummary(useJudge);
} else if (cmd === "save" && (kind === "marketing" || kind === "summary")) {
  if (!arg || arg.startsWith("--")) {
    console.error(`usage: subagent-runner.ts save ${kind} <workflow-result.json>`);
    process.exit(2);
  }
  saveSubagentResult(kind, arg);
} else {
  console.error(
    "usage: subagent-runner.ts <prep|save> <marketing|summary> [result.json] [--judge]",
  );
  process.exit(2);
}
