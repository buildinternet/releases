/**
 * CLI surface + lifecycle coverage for `admin work` (#227). The work commands
 * are local (no network), so unlike most admin actions they run end-to-end in
 * the harness — we point RELEASES_DATA_DIR at a temp dir so the sticky pointer
 * never touches the real ~/.releases.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../utils.js";

function parseJson(stdout: string): unknown {
  const start = stdout.indexOf("{");
  return JSON.parse(stdout.slice(start));
}

describe("admin work --help surface", () => {
  it("lists start, status, and end subcommands", () => {
    const { stdout, exitCode } = runCli(["admin", "work", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("start");
    expect(stdout).toContain("status");
    expect(stdout).toContain("end");
  });

  it("`work start --help` documents the sticky pointer", () => {
    const { stdout, exitCode } = runCli(["admin", "work", "start", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(".current-run");
    expect(stdout).toContain("RELEASES_RUN_DIR");
  });
});

describe("admin work lifecycle", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "rel-work-cli-"));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const env = () => ({ RELEASES_DATA_DIR: dataDir, RELEASES_TELEMETRY_DISABLED: "1" });

  it("start → status → end → status flows across separate invocations", () => {
    const start = runCli(["admin", "work", "start", "Overview Sweep", "--json"], { env: env() });
    expect(start.exitCode).toBe(0);
    const started = parseJson(start.stdout) as { runDir: string; source: string };
    expect(started.source).toBe("pointer");
    expect(started.runDir).toContain(join(dataDir, "work", "runs"));
    expect(started.runDir).toContain("overview-sweep");

    // A fresh process (no RELEASES_RUN_DIR in env) still resolves the run via
    // the pointer — the whole point of #227.
    const status = runCli(["admin", "work", "status", "--json"], { env: env() });
    expect(status.exitCode).toBe(0);
    const active = parseJson(status.stdout) as { active: boolean; runDir: string; source: string };
    expect(active.active).toBe(true);
    expect(active.source).toBe("pointer");
    expect(active.runDir).toBe(started.runDir);

    const end = runCli(["admin", "work", "end", "--json"], { env: env() });
    expect(end.exitCode).toBe(0);
    expect((parseJson(end.stdout) as { ended: boolean }).ended).toBe(true);

    const after = runCli(["admin", "work", "status", "--json"], { env: env() });
    expect(after.exitCode).toBe(0);
    expect((parseJson(after.stdout) as { active: boolean }).active).toBe(false);
  });
});
