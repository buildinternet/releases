import { describe, it, expect } from "bun:test";
import { runCli } from "../utils.js";

/**
 * Integration coverage for `releases admin org delete --hard`.
 *
 * The runCli helper spawns the CLI as a subprocess with piped stdio, so
 * `process.stdin.isTTY` is `false` inside the child. That gates the two
 * behaviors we can assert without mocking fetch:
 *
 *   1. `--hard` without `--yes` from a non-TTY exits 1 with a clear
 *      "no interactive TTY" message — before any DELETE is issued.
 *   2. `org delete <slug>` and `org remove <slug>` are aliases — both must
 *      surface the new flags in --help output.
 *
 * Typeback success / mismatch are unit-tested against `promptConfirm`
 * directly in tests/unit/confirm.test.ts (the readline path can't be driven
 * cleanly through spawnSync's piped stdin).
 */
describe("admin org delete --hard (CLI integration)", () => {
  it("rejects --hard without --yes when stdin is not a TTY", () => {
    const { stderr, exitCode } = runCli(["admin", "org", "delete", "vercel", "--hard"], {
      env: { RELEASED_API_URL: "https://test.example.com", RELEASED_API_KEY: "test" },
    });
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--yes");
  });

  it("exposes --hard and --yes flags on the delete subcommand", () => {
    const { stdout, exitCode } = runCli(["admin", "org", "delete", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--hard");
    expect(stdout).toContain("--yes");
  });

  it("treats `org remove` as an alias of `org delete`", () => {
    const { stdout, exitCode } = runCli(["admin", "org", "remove", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--hard");
  });
});
