import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";

// Coverage for scripts/run-timed.mjs — the wall-clock wrapper that bounds
// short-lived local wrangler D1 one-shots and, on deadline, kills the whole
// PROCESS GROUP so a timed-out agent can't orphan a multi-GB miniflare boot.
// This encodes the manual checklist from the porting note (issue #2121) so a
// future refactor can't silently regress to a child-only kill (the exact bug
// the wrapper guards against) without turning CI red.

const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "run-timed.mjs");

// Distinct sleep durations per test → precise, collision-free pgrep matches
// (no other suite spawns bare `sleep 3x`). Long enough to still be alive when
// we probe, short enough that a genuine reaping failure self-clears quickly.
const GRANDCHILD_SLEEP = "3701";
const STRAGGLER_SLEEP = "3702";

function runTimedCli(seconds: number, cmd: string[], extraEnv: Record<string, string> = {}) {
  const proc = Bun.spawnSync(["node", SCRIPT, String(seconds), "--", ...cmd], {
    env: { ...process.env, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function pgrepCount(pattern: string): number {
  const p = Bun.spawnSync(["pgrep", "-f", pattern], { stdout: "pipe" });
  const out = p.stdout.toString().trim();
  return out ? out.split("\n").filter(Boolean).length : 0;
}

afterAll(() => {
  // Safety net: if any assertion below failed mid-reap, don't leak a sleeper.
  for (const d of [GRANDCHILD_SLEEP, STRAGGLER_SLEEP]) {
    Bun.spawnSync(["pkill", "-9", "-f", `sleep ${d}`], { stdout: "ignore", stderr: "ignore" });
  }
});

describe("run-timed.mjs", () => {
  it("passes through a fast command's success (exit 0)", () => {
    const r = runTimedCli(5, ["echo", "ok"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ok");
  });

  it("exits 124 when the command outlives the deadline (primary timeout path)", () => {
    const r = runTimedCli(1, ["sleep", "5"]);
    expect(r.code).toBe(124);
  });

  it("detached-group fallback kills grandchildren on deadline", () => {
    const r = runTimedCli(
      2,
      ["sh", "-c", `sleep ${GRANDCHILD_SLEEP} & sleep ${GRANDCHILD_SLEEP}`],
      { RUN_TIMED_FORCE_FALLBACK: "1" },
    );
    expect(r.code).toBe(124);
    Bun.sleepSync(1000); // let SIGKILL propagate to the group
    expect(pgrepCount(`sleep ${GRANDCHILD_SLEEP}`)).toBe(0);
  }, 20_000);

  it("detached-group fallback force-kills a SIGTERM-ignoring straggler", () => {
    const r = runTimedCli(
      2,
      ["sh", "-c", `(trap "" TERM; sleep ${STRAGGLER_SLEEP}) & sleep ${STRAGGLER_SLEEP}`],
      { RUN_TIMED_FORCE_FALLBACK: "1" },
    );
    expect(r.code).toBe(124);
    Bun.sleepSync(1500); // exit-time SIGKILL reaps the TERM-ignoring child
    expect(pgrepCount(`sleep ${STRAGGLER_SLEEP}`)).toBe(0);
  }, 20_000);
});
