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
 *     -> persists the Workflow's returned JSON into ~/.releases/evals/results/
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
import {
  SYSTEM_PROMPT as OVERVIEW_SYSTEM_PROMPT,
  buildUserMessageContent,
  MODEL as OVERVIEW_MODEL,
  type OverviewRequestInput,
} from "@releases/ai-internal/overview-content";
import { buildGraderPrompt } from "@releases/ai-internal/grader-prompt";
import {
  DEFAULT_FORBIDDEN_SUBSTRINGS,
  gradeOverviewStructural,
  type StructuralSpec,
} from "./graders";
import {
  loadOverviewFixtures,
  overviewRubricPath,
  type OverviewFixture,
} from "./overview-fixtures";
import type { FieldResult } from "./helpers";
import { saveRun } from "./results";
import { getEvalsDir } from "@releases/lib/config";

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
    .sort((a, b) => a.localeCompare(b))
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

// ── Overview (driven by the Agent tool, not a Workflow) ─────────────
//
// Unlike marketing/summary (which fan out inside a Workflow whose sandbox can't
// import repo code, so they mirror graders.ts inline), the overview sub-agent
// eval is driven by the parent session's Agent tool: prep composes the prompt,
// the parent dispatches the `overview-writer` agent per fixture, writes each
// returned body to <bodiesDir>/<name>.md, then `grade overview` runs the REAL
// gradeOverviewStructural here — no inline mirror, no drift. The optional
// `overview-grader` (Sonnet) verdicts fold in via --verdicts.
//
// Citation integrity is NOT graded on this path: a free-text sub-agent cannot
// emit Anthropic's native search_result citation objects. That check stays on
// the metered `bun run eval:overview` path.

/** Flatten the production user-message blocks (search_result + framing text) to
 * plain text a free-text sub-agent can consume. Reuses the canonical builder so
 * the inputs stay in lockstep with the metered path. */
function flattenOverviewInput(input: OverviewRequestInput): string {
  return buildUserMessageContent(input)
    .map((b) => {
      if (b.type === "search_result") {
        const body = (b.content as Array<{ type: "text"; text: string }>)
          .map((c) => c.text)
          .join("\n");
        return `<release source="${b.source}" title="${b.title ?? ""}">\n${body}\n</release>`;
      }
      return b.type === "text" ? b.text : "";
    })
    .join("\n\n");
}

function prepOverview(useJudge: boolean) {
  const fixtures = loadOverviewFixtures();

  const outDir = join(tmpdir(), "releases-subagent-eval", "overview");
  mkdirSync(outDir, { recursive: true });

  const cases = fixtures.map((f) => {
    const composed = `${OVERVIEW_SYSTEM_PROMPT}\n\n---\nGenerate the overview body now. Output ONLY the markdown body — no preamble, no code fences, no headings.\n\n${flattenOverviewInput(f.input)}`;
    const promptFile = join(outDir, `${f.name}.txt`);
    writeFileSync(promptFile, composed);
    return {
      name: f.name,
      promptFile,
      orgName: f.input.org.name,
      structural: f.structural ?? {},
    };
  });

  process.stdout.write(
    JSON.stringify({
      kind: "overview",
      judge: useJudge,
      model: OVERVIEW_MODEL,
      rubricFile: useJudge ? overviewRubricPath() : null,
      bodiesHint: outDir,
      cases,
    }),
  );
}

/** One-line evidence string for a graded field, for the viewer's grading.json. */
function fieldEvidence(f: FieldResult): string {
  const exp = typeof f.expected === "string" ? f.expected : JSON.stringify(f.expected);
  const act = typeof f.actual === "string" ? f.actual : JSON.stringify(f.actual);
  return f.passed ? `ok — ${act}` : `expected ${exp}, got ${act}`;
}

/** Short human-readable description of what a fixture asks for (viewer prompt pane). */
function viewerPrompt(input: OverviewRequestInput): string {
  const desc = input.org.description ? ` (${input.org.description})` : "";
  const sources = input.sources.map((s) => s.name).join(", ");
  return `Generate the overview knowledge page for ${input.org.name}${desc} from ${input.selected.length} releases across ${input.sources.length} source(s): ${sources}.`;
}

/**
 * Materialize one graded fixture into the skill-creator eval-viewer's workspace
 * convention (a dir containing outputs/ + grading.json + eval_metadata.json),
 * so `generate_review.py` can render the produced overview body inline next to
 * its grades with a feedback box. The viewer just reads this directory shape —
 * it is fully decoupled from how the run was produced.
 */
function materializeViewerCase(
  viewerDir: string,
  index: number,
  fixture: OverviewFixture,
  body: string,
  fields: FieldResult[],
) {
  const runDir = join(viewerDir, `eval-${fixture.name}`);
  mkdirSync(join(runDir, "outputs"), { recursive: true });
  writeFileSync(join(runDir, "outputs", "overview.md"), body);
  writeFileSync(
    join(runDir, "eval_metadata.json"),
    JSON.stringify(
      { eval_id: index, eval_name: fixture.name, prompt: viewerPrompt(fixture.input) },
      null,
      2,
    ),
  );
  const passedCount = fields.filter((f) => f.passed).length;
  writeFileSync(
    join(runDir, "grading.json"),
    JSON.stringify(
      {
        expectations: fields.map((f) => ({
          text: f.field,
          passed: f.passed,
          evidence: fieldEvidence(f),
        })),
        summary: {
          passed: passedCount,
          failed: fields.length - passedCount,
          total: fields.length,
          pass_rate: fields.length > 0 ? passedCount / fields.length : 0,
        },
      },
      null,
      2,
    ),
  );
}

/**
 * Grade sub-agent-produced overview bodies. Reads <bodiesDir>/<name>.md per
 * fixture, runs the real structural grader. With --judge but no --verdicts,
 * writes <bodiesDir>/<name>.grader.txt (the buildGraderPrompt artifact) for the
 * overview-grader agent to consume, and skips saving (run is incomplete). With
 * --verdicts <file> (a JSON map name -> { result }), folds the Sonnet verdict in
 * and saves the run. With --viewer <dir>, also materializes a skill-creator
 * eval-viewer workspace so the bodies can be reviewed in the browser.
 */
function gradeOverview(
  bodiesDir: string,
  useJudge: boolean,
  verdictsFile: string | null,
  viewerDir: string | null,
) {
  const fixtures = loadOverviewFixtures();
  const rubric = useJudge ? readFileSync(overviewRubricPath(), "utf8") : "";
  const verdicts: Record<string, { result?: string }> = verdictsFile
    ? JSON.parse(readFileSync(verdictsFile, "utf8"))
    : {};

  const awaitingVerdict: string[] = [];
  let allPassed = true;
  const cases: Array<{
    name: string;
    passed: boolean;
    fields: FieldResult[];
    index: number;
    fixture: OverviewFixture;
    body: string;
  }> = [];

  console.error(`\n${"=".repeat(60)}`);
  console.error(
    `Overview sub-agent eval${useJudge ? " (+ judge)" : ""}: ${fixtures.length} fixtures`,
  );
  console.error("=".repeat(60));

  for (const [index, f] of fixtures.entries()) {
    const bodyFile = join(bodiesDir, `${f.name}.md`);
    let fields: FieldResult[];
    let passed: boolean;
    let body = "";
    try {
      body = readFileSync(bodyFile, "utf8");
      const structural = gradeOverviewStructural(body, {
        orgName: f.input.org.name,
        ...f.structural,
      });
      fields = structural.fields;
      passed = structural.passed;

      if (useJudge && body.trim().length > 0) {
        const v = verdicts[f.name];
        if (v) {
          const ok = v.result === "satisfied";
          fields = [
            ...fields,
            { field: "judge: satisfied", passed: ok, expected: "satisfied", actual: v.result },
          ];
          passed = passed && ok;
        } else {
          const graderFile = join(bodiesDir, `${f.name}.grader.txt`);
          writeFileSync(
            graderFile,
            buildGraderPrompt({ rubric, artifact: body, rubricLabel: "overview.md" }),
          );
          awaitingVerdict.push(graderFile);
        }
      }
    } catch (err) {
      fields = [{ field: "body produced", passed: false, expected: bodyFile, actual: String(err) }];
      passed = false;
    }

    allPassed = allPassed && passed;
    cases.push({ name: f.name, passed, fields, index, fixture: f, body });
    console.error(`  ${passed ? "PASS" : "FAIL"}  ${f.name}`);
    for (const fld of fields) {
      if (!fld.passed) {
        console.error(
          `        ${fld.field}: expected=${JSON.stringify(fld.expected)}, actual=${JSON.stringify(fld.actual)}`,
        );
      }
    }
  }

  if (useJudge && awaitingVerdict.length > 0) {
    console.error(
      `\nAwaiting judge verdicts. Dispatch the overview-grader agent on each grader prompt, then re-run with --verdicts:`,
    );
    for (const g of awaitingVerdict) console.error(`  ${g}`);
    console.error(
      `\n  bun tests/evals/subagent-runner.ts grade overview ${bodiesDir} --judge --verdicts <verdicts.json>\n`,
    );
    return;
  }

  if (viewerDir) {
    mkdirSync(viewerDir, { recursive: true });
    for (const c of cases) {
      materializeViewerCase(viewerDir, c.index, c.fixture, c.body, c.fields);
    }
    console.error(`\nviewer workspace: ${viewerDir}`);
    console.error(
      `  python <skill-creator>/eval-viewer/generate_review.py ${viewerDir} --skill-name overview-eval --static ${join(viewerDir, "review.html")}\n`,
    );
  }

  const file = saveRun({
    eval: "overview-subagent",
    model: OVERVIEW_MODEL,
    pass: allPassed,
    summary: {
      total: cases.length,
      passed: cases.filter((c) => c.passed).length,
      judge: useJudge,
    },
    cases: cases.map((c) => ({ name: c.name, passed: c.passed, fields: c.fields })),
  });
  console.error(`\n${allPassed ? "PASS" : "FAIL"}`);
  console.error(`results: ${file}\n`);
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
} else if (cmd === "prep" && kind === "overview") {
  prepOverview(useJudge);
} else if (cmd === "grade" && kind === "overview") {
  if (!arg || arg.startsWith("--")) {
    console.error(
      "usage: subagent-runner.ts grade overview <bodiesDir> [--judge --verdicts <f>] [--viewer <dir>]",
    );
    process.exit(2);
  }
  const vi = process.argv.indexOf("--verdicts");
  const verdictsFile = vi >= 0 ? (process.argv[vi + 1] ?? null) : null;
  // --viewer [dir]: explicit dir, or default to ~/.releases/evals/runs/<eval>-<ts>/
  const wi = process.argv.indexOf("--viewer");
  let viewerDir: string | null = null;
  if (wi >= 0) {
    const next = process.argv[wi + 1];
    viewerDir =
      next && !next.startsWith("--")
        ? next
        : join(
            getEvalsDir(),
            "runs",
            `overview-subagent-${new Date().toISOString().replace(/[:.]/g, "-")}`,
          );
  }
  gradeOverview(arg, useJudge, verdictsFile, viewerDir);
} else if (cmd === "save" && (kind === "marketing" || kind === "summary")) {
  if (!arg || arg.startsWith("--")) {
    console.error(`usage: subagent-runner.ts save ${kind} <workflow-result.json>`);
    process.exit(2);
  }
  saveSubagentResult(kind, arg);
} else {
  console.error(
    "usage: subagent-runner.ts <prep|grade|save> <marketing|summary|overview> [arg] [--judge] [--verdicts <f>]",
  );
  process.exit(2);
}
