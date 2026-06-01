/**
 * Persist a local eval run to the gitignored tests/evals/results/ dir — the
 * location the eval framework reserved in .gitignore back in #81. Writes one
 * timestamped JSON per run plus a `<eval>-latest.json` pointer for quick access.
 *
 * Each record carries the git SHA (which prompt version was under test), the
 * model, the pass/fail gate, and per-case detail, so two runs are directly
 * diffable across a prompt or model change.
 *
 * Honors RELEASES_EVAL_DIR to relocate the results dir (e.g. point it at
 * ~/.releases/evals to keep results out of the repo tree entirely).
 *
 * Local/ad-hoc only — these scripts never run in CI.
 */
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

export interface EvalRunInput {
  /** Short eval name, used as the filename prefix (e.g. "marketing", "summary"). */
  eval: string;
  /** Model under test (e.g. "claude-haiku-4-5"). */
  model: string;
  /** Did the run pass its gate? */
  pass: boolean;
  /** Aggregate metrics + gate thresholds. */
  summary: Record<string, unknown>;
  /** Per-case detail. */
  cases: unknown[];
}

function resultsDir(): string {
  const override = process.env.RELEASES_EVAL_DIR;
  return override && override.length > 0 ? override : join(import.meta.dir, "results");
}

function gitSha(): string | null {
  try {
    const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" });
    const sha = r.stdout?.trim();
    return sha && sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

/** Write the run to <results>/<eval>-<timestamp>.json and <eval>-latest.json. Returns the timestamped path. */
export function saveRun(input: EvalRunInput): string {
  const dir = resultsDir();
  mkdirSync(dir, { recursive: true });

  const timestamp = new Date().toISOString();
  const record = { ...input, timestamp, gitSha: gitSha() };
  const body = JSON.stringify(record, null, 2);

  const file = join(dir, `${input.eval}-${timestamp.replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, body);
  writeFileSync(join(dir, `${input.eval}-latest.json`), body);
  return file;
}
