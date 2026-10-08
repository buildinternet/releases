/**
 * Unit tests for the sticky run-dir pointer (#227).
 *
 * RELEASES_DATA_DIR is pinned at a fresh temp dir per test so getWorkDir /
 * getRunsDir resolve there (config re-resolves when the env changes), keeping
 * the pointer file out of the real ~/.releases and isolating tests from each
 * other and from file order.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  resolveRunDir,
  resolveRunDirSource,
  pointerPath,
  readPointer,
  startRun,
  endRun,
  runStatus,
  runTimestamp,
  slugifyBatch,
} from "../../src/lib/run-dir.js";

let dataDir: string;
let prevDataDir: string | undefined;
let prevRunDir: string | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "rel-rundir-"));
  prevDataDir = process.env.RELEASES_DATA_DIR;
  prevRunDir = process.env.RELEASES_RUN_DIR;
  process.env.RELEASES_DATA_DIR = dataDir;
  delete process.env.RELEASES_RUN_DIR;
});
afterEach(() => {
  if (prevDataDir === undefined) delete process.env.RELEASES_DATA_DIR;
  else process.env.RELEASES_DATA_DIR = prevDataDir;
  if (prevRunDir === undefined) delete process.env.RELEASES_RUN_DIR;
  else process.env.RELEASES_RUN_DIR = prevRunDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("runTimestamp / slugifyBatch", () => {
  it("formats a timestamp as YYYY-MM-DD-HHMM (local wall clock)", () => {
    expect(runTimestamp(new Date(2026, 4, 25, 10, 31))).toBe("2026-05-25-1031");
    expect(runTimestamp(new Date(2026, 0, 1, 0, 5))).toBe("2026-01-01-0005");
  });

  it("slugifies a batch label, collapsing non-alnum runs", () => {
    expect(slugifyBatch("overview-sweep")).toBe("overview-sweep");
    expect(slugifyBatch("Q2 Audit!")).toBe("q2-audit");
    expect(slugifyBatch("  Trim — Me  ")).toBe("trim-me");
  });

  it("falls back to `run` when the label has no alnum", () => {
    expect(slugifyBatch("!!!")).toBe("run");
    expect(slugifyBatch("   ")).toBe("run");
  });
});

describe("resolveRunDir precedence", () => {
  it("returns undefined when neither env nor pointer is set", () => {
    expect(resolveRunDir()).toBeUndefined();
    expect(resolveRunDirSource()).toBeUndefined();
  });

  it("uses RELEASES_RUN_DIR when set, expanding a tilde", () => {
    process.env.RELEASES_RUN_DIR = "/explicit/run";
    expect(resolveRunDir()).toBe("/explicit/run");
    expect(resolveRunDirSource()).toBe("env");

    process.env.RELEASES_RUN_DIR = "~/runs/x";
    expect(resolveRunDir()).toBe(join(homedir(), "runs/x"));
  });

  it("falls back to the .current-run pointer when env is unset", () => {
    const dir = startRun("overview-sweep");
    expect(resolveRunDir()).toBe(dir);
    expect(resolveRunDirSource()).toBe("pointer");
    expect(readPointer()).toBe(dir);
  });

  it("lets RELEASES_RUN_DIR win over an existing pointer", () => {
    startRun("overview-sweep");
    process.env.RELEASES_RUN_DIR = "/env/wins";
    expect(resolveRunDir()).toBe("/env/wins");
    expect(resolveRunDirSource()).toBe("env");
  });
});

describe("startRun", () => {
  it("creates <dataDir>/work/runs/<ts>-<slug> and writes the pointer", () => {
    const dir = startRun("Overview Sweep", new Date(2026, 4, 25, 10, 31));
    expect(dir).toBe(join(dataDir, "work", "runs", "2026-05-25-1031-overview-sweep"));
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(pointerPath())).toBe(true);
    expect(readFileSync(pointerPath(), "utf-8").trim()).toBe(dir);
  });

  it("honors RELEASES_DATA_DIR for the run location", () => {
    const dir = startRun("x");
    expect(dir.startsWith(join(dataDir, "work", "runs"))).toBe(true);
  });
});

describe("endRun", () => {
  it("clears the pointer and reports whether one was present", () => {
    startRun("sweep");
    expect(existsSync(pointerPath())).toBe(true);
    expect(endRun()).toBe(true);
    expect(existsSync(pointerPath())).toBe(false);
    expect(resolveRunDir()).toBeUndefined();
    // Second end is a no-op.
    expect(endRun()).toBe(false);
  });
});

describe("runStatus", () => {
  it("returns undefined when there is no active run", () => {
    expect(runStatus()).toBeUndefined();
  });

  it("tallies mutations and traced sessions in the active run", () => {
    const dir = startRun("sweep");
    writeFileSync(
      join(dir, "mutations.jsonl"),
      [
        JSON.stringify({ target: "PATCH /v1/orgs/a" }),
        JSON.stringify({ target: "DELETE /v1/sources/s" }),
        "", // trailing blank line should not count
      ].join("\n"),
    );
    // One traced session (dir with trace.json) + one bare dir that doesn't count.
    mkdirSync(join(dir, "sess_1"), { recursive: true });
    writeFileSync(join(dir, "sess_1", "trace.json"), "{}");
    mkdirSync(join(dir, "not-a-session"), { recursive: true });

    const status = runStatus();
    expect(status).toBeDefined();
    expect(status!.source).toBe("pointer");
    expect(status!.exists).toBe(true);
    expect(status!.mutations).toBe(2);
    expect(status!.sessions).toBe(1);
  });

  it("flags a stale pointer whose dir no longer exists", () => {
    // getWorkDir() (via pointerPath) creates <dataDir>/work so the pointer can
    // be written even though the target run dir does not exist.
    writeFileSync(pointerPath(), "/no/such/run\n");
    const status = runStatus();
    expect(status).toBeDefined();
    expect(status!.runDir).toBe("/no/such/run");
    expect(status!.exists).toBe(false);
    expect(status!.mutations).toBe(0);
    expect(status!.sessions).toBe(0);
  });
});
