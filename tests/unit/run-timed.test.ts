import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";

// Coverage for scripts/run-timed.mjs — the wall-clock wrapper that bounds
// short-lived local wrangler D1 one-shots and, on deadline, kills the whole
// PROCESS GROUP so a timed-out agent can't orphan a multi-GB miniflare boot.
// This encodes the manual checklist from the porting note (issue #2121) so a
// future refactor can't silently regress to a child-only kill (the exact bug
// the wrapper guards against) without turning CI red.
//
// The cases are almost pure wall-clock waiting (spawn a subprocess, wait for a
// deadline + SIGKILL to propagate), so they run `it.concurrent` to overlap
// their idle time instead of summing it — file wall drops ~7.7s → ~3.7s. This
// requires async spawn/sleep below: `Bun.spawnSync`/`Bun.sleepSync` block the
// single JS thread and would serialize the concurrent cases right back. Overlap
// is safe because each case probes the process table by a distinct sleep
// duration (below), so no case can see another's sleepers.

const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "run-timed.mjs");

// Distinct sleep durations per test → precise, collision-free pgrep matches
// (no other suite spawns bare `sleep 3x`). Long enough to still be alive when
// we probe, short enough that a genuine reaping failure self-clears quickly.
// The distinctness is also what makes the concurrent execution above safe.
const GRANDCHILD_SLEEP = "3701";
const STRAGGLER_SLEEP = "3702";

async function runTimedCli(seconds: number, cmd: string[], extraEnv: Record<string, string> = {}) {
  const proc = Bun.spawn(["node", SCRIPT, String(seconds), "--", ...cmd], {
    env: { ...process.env, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  // Read both streams to completion and await exit concurrently; `proc.exited`
  // resolves to the exit code once the process is reaped.
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

async function pgrepCount(pattern: string): Promise<number> {
  const proc = Bun.spawn(["pgrep", "-f", pattern], { stdout: "pipe", stderr: "ignore" });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return out ? out.split("\n").filter(Boolean).length : 0;
}

afterAll(() => {
  // Safety net: if any assertion below failed mid-reap, don't leak a sleeper.
  for (const d of [GRANDCHILD_SLEEP, STRAGGLER_SLEEP]) {
    Bun.spawnSync(["pkill", "-9", "-f", `sleep ${d}`], { stdout: "ignore", stderr: "ignore" });
  }
});

describe("run-timed.mjs", () => {
  it.concurrent("passes through a fast command's success (exit 0)", async () => {
    const r = await runTimedCli(5, ["echo", "ok"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ok");
  });

  it.concurrent("exits 124 when the command outlives the deadline (primary timeout path)", async () => {
    const r = await runTimedCli(1, ["sleep", "5"]);
    expect(r.code).toBe(124);
  });

  it.concurrent("detached-group fallback kills grandchildren on deadline", async () => {
    const r = await runTimedCli(
      2,
      ["sh", "-c", `sleep ${GRANDCHILD_SLEEP} & sleep ${GRANDCHILD_SLEEP}`],
      { RUN_TIMED_FORCE_FALLBACK: "1" },
    );
    expect(r.code).toBe(124);
    await Bun.sleep(1000); // let SIGKILL propagate to the group
    expect(await pgrepCount(`sleep ${GRANDCHILD_SLEEP}`)).toBe(0);
  }, 20_000);

  it.concurrent("detached-group fallback force-kills a SIGTERM-ignoring straggler", async () => {
    const r = await runTimedCli(
      2,
      ["sh", "-c", `(trap "" TERM; sleep ${STRAGGLER_SLEEP}) & sleep ${STRAGGLER_SLEEP}`],
      { RUN_TIMED_FORCE_FALLBACK: "1" },
    );
    expect(r.code).toBe(124);
    await Bun.sleep(1500); // exit-time SIGKILL reaps the TERM-ignoring child
    expect(await pgrepCount(`sleep ${STRAGGLER_SLEEP}`)).toBe(0);
  }, 20_000);
});
