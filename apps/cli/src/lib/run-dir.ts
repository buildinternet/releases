import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getRunsDir, getWorkDir, expandHome } from "@buildinternet/releases-lib/config";

/**
 * Sticky run-dir pointer for the maintenance workspace (#227).
 *
 * `RELEASES_RUN_DIR` is the documented way to auto-capture admin mutations
 * into `mutations.jsonl` and to default the managed-session trace dir. But a
 * one-time `export RELEASES_RUN_DIR=…` does not survive an agent harness —
 * Claude Code runs each Bash tool call in a fresh shell, so the export silently
 * stops carrying after the first command and later mutations go unrecorded with
 * no error.
 *
 * `work start` writes a sticky pointer file (`<workDir>/.current-run`) holding
 * the run dir, and the resolver below reads it. So neither a persistent shell
 * nor inline `RELEASES_RUN_DIR=…` threading is required. Explicit
 * `RELEASES_RUN_DIR` still wins when set (back-compat).
 *
 * Everything here honors `RELEASES_DATA_DIR` via `@buildinternet/releases-lib/config`. See
 * `docs/architecture/maintenance-workspace.md` in the monorepo.
 */

const RUN_DIR_ENV = "RELEASES_RUN_DIR";
const POINTER_FILE = ".current-run";
const MUTATIONS_FILE = "mutations.jsonl";

/** Absolute path to the sticky pointer file (`<dataDir>/work/.current-run`). */
export function pointerPath(): string {
  return join(getWorkDir(), POINTER_FILE);
}

/** Read the sticky pointer, or `undefined` when missing/empty. Fail-safe. */
export function readPointer(): string | undefined {
  try {
    const p = pointerPath();
    if (!existsSync(p)) return undefined;
    const value = readFileSync(p, "utf-8").trim();
    return value ? expandHome(value) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the active run dir, in precedence order:
 *   1. explicit `RELEASES_RUN_DIR` env (wins when set),
 *   2. the sticky `.current-run` pointer (written by `work start`),
 *   3. none.
 *
 * The returned path is tilde-expanded.
 */
export function resolveRunDir(): string | undefined {
  const env = process.env[RUN_DIR_ENV];
  if (env) return expandHome(env);
  return readPointer();
}

/** Where the active run dir came from — for `work status` reporting. */
export type RunDirSource = "env" | "pointer";

export function resolveRunDirSource(): RunDirSource | undefined {
  if (process.env[RUN_DIR_ENV]) return "env";
  if (readPointer()) return "pointer";
  return undefined;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** `2026-05-25-1031` — local wall-clock, the convention for human run dirs. */
export function runTimestamp(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}`;
}

/** Lowercase, dash-joined slug; collapses runs of non-alnum. Falls back to `run`. */
export function slugifyBatch(batch: string): string {
  const slug = batch
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "run";
}

/**
 * Create `<runsDir>/<ts>-<batch>/` and point `.current-run` at it. Returns the
 * created run dir. `now` is injectable for deterministic tests.
 */
export function startRun(batch: string, now: Date = new Date()): string {
  const dir = join(getRunsDir(), `${runTimestamp(now)}-${slugifyBatch(batch)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(pointerPath(), dir + "\n");
  return dir;
}

/** Clear the sticky pointer. Returns `true` if one was present. */
export function endRun(): boolean {
  const p = pointerPath();
  if (!existsSync(p)) return false;
  rmSync(p);
  return true;
}

export interface RunStatus {
  runDir: string;
  source: RunDirSource;
  /** Whether the run dir exists on disk yet. */
  exists: boolean;
  /** Lines in `mutations.jsonl` (0 when absent). */
  mutations: number;
  /** Subdirectories containing a `trace.json` (0 when absent). */
  sessions: number;
}

/** Count non-empty lines in `<runDir>/mutations.jsonl`. Fail-safe → 0. */
function countMutations(runDir: string): number {
  try {
    const file = join(runDir, MUTATIONS_FILE);
    if (!existsSync(file)) return 0;
    return readFileSync(file, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

/** Count immediate subdirs that hold a `trace.json` (a saved session/workflow). */
function countSessions(runDir: string): number {
  try {
    if (!existsSync(runDir)) return 0;
    return readdirSync(runDir, { withFileTypes: true }).filter(
      (e) => e.isDirectory() && existsSync(join(runDir, e.name, "trace.json")),
    ).length;
  } catch {
    return 0;
  }
}

/** Resolve the active run and tally its contents, or `undefined` if none. */
export function runStatus(): RunStatus | undefined {
  const source = resolveRunDirSource();
  if (!source) return undefined;
  const runDir = resolveRunDir();
  if (!runDir) return undefined;
  return {
    runDir,
    source,
    exists: existsSync(runDir),
    mutations: countMutations(runDir),
    sessions: countSessions(runDir),
  };
}
