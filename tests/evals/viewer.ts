/**
 * Materialize graded eval cases into the skill-creator eval-viewer's workspace
 * convention so `generate_review.py` can render each produced artifact inline
 * next to its grades with a feedback box.
 *
 * Shared by every sub-agent eval driver (overview / summary / marketing) — the
 * shape is the only contract the viewer cares about, so the same helper feeds
 * all of them. One `eval-<name>/` per case, each containing:
 *   outputs/<artifact>     — the produced artifact (markdown), rendered inline
 *   grading.json           — per-field pass/fail + evidence + a summary block
 *   eval_metadata.json     — the case name + a one-line prompt for the prompt pane
 *
 * The viewer is fully decoupled from how a run was produced; it just reads this
 * directory shape. See SUBAGENT-EVALS.md.
 */
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { getEvalsDir } from "@releases/lib/config";
import type { FieldResult } from "./helpers";

/** One-line evidence string for a graded field, for the viewer's grading.json. */
export function fieldEvidence(f: FieldResult): string {
  const exp = typeof f.expected === "string" ? f.expected : JSON.stringify(f.expected);
  const act = typeof f.actual === "string" ? f.actual : JSON.stringify(f.actual);
  return f.passed ? `ok — ${act}` : `expected ${exp}, got ${act}`;
}

export interface ViewerCase {
  /** Fixture/case name → an `eval-<name>/` workspace dir. */
  name: string;
  /** One-line description of what the case asked for (the viewer's prompt pane). */
  prompt: string;
  /** Artifact filename under `outputs/` (e.g. "overview.md", "summary.md"). */
  outputName: string;
  /** The produced artifact body, rendered inline in the viewer. */
  body: string;
  /** Graded fields → grading.json expectations. */
  fields: FieldResult[];
}

/** Default viewer workspace dir: `~/.releases/evals/runs/<eval>-<timestamp>/`. */
export function defaultViewerDir(evalName: string): string {
  return join(
    getEvalsDir(),
    "runs",
    `${evalName}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
}

/** Write one graded case into the eval-viewer workspace convention. */
export function materializeViewerCase(viewerDir: string, index: number, c: ViewerCase): void {
  const runDir = join(viewerDir, `eval-${c.name}`);
  mkdirSync(join(runDir, "outputs"), { recursive: true });
  writeFileSync(join(runDir, "outputs", c.outputName), c.body);
  writeFileSync(
    join(runDir, "eval_metadata.json"),
    JSON.stringify({ eval_id: index, eval_name: c.name, prompt: c.prompt }, null, 2),
  );
  const passedCount = c.fields.filter((f) => f.passed).length;
  writeFileSync(
    join(runDir, "grading.json"),
    JSON.stringify(
      {
        expectations: c.fields.map((f) => ({
          text: f.field,
          passed: f.passed,
          evidence: fieldEvidence(f),
        })),
        summary: {
          passed: passedCount,
          failed: c.fields.length - passedCount,
          total: c.fields.length,
          pass_rate: c.fields.length > 0 ? passedCount / c.fields.length : 0,
        },
      },
      null,
      2,
    ),
  );
}

/** Materialize a whole run's worth of graded cases under `viewerDir`. */
export function materializeViewerWorkspace(viewerDir: string, cases: ViewerCase[]): void {
  mkdirSync(viewerDir, { recursive: true });
  cases.forEach((c, i) => materializeViewerCase(viewerDir, i, c));
}
