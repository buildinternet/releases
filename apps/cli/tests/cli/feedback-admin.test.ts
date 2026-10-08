import { describe, it, expect } from "bun:test";
import { runCli } from "../utils.js";

/**
 * Integration coverage for the `releases admin feedback` triage write-path
 * (triage / archive / delete). runCli spawns the CLI with piped stdio, so
 * `process.stdin.isTTY` is false in the child. We assert the guard rails that
 * fire BEFORE any network call — invalid input and the destructive-delete
 * confirmation gate — plus that the new verbs and flags surface in --help.
 *
 * The promptConfirm typeback path itself is unit-tested in
 * tests/unit/confirm.test.ts (readline can't be driven through piped stdin).
 */
describe("admin feedback triage write-path (CLI integration)", () => {
  it("lists triage / archive / delete subcommands in help", () => {
    const { stdout, exitCode } = runCli(["admin", "feedback", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("triage");
    expect(stdout).toContain("archive");
    expect(stdout).toContain("delete");
  });

  it("requires --status on triage", () => {
    const { stderr, exitCode } = runCli(["admin", "feedback", "triage", "fb_x"]);
    expect(exitCode).not.toBe(0);
    expect(stderr.toLowerCase()).toContain("status");
  });

  it("rejects an invalid triage status before any request", () => {
    const { stderr, exitCode } = runCli([
      "admin",
      "feedback",
      "triage",
      "fb_x",
      "--status",
      "bogus",
    ]);
    expect(exitCode).not.toBe(0);
    // The valid set is echoed back so the operator can self-correct.
    expect(stderr).toContain("triaged");
  });

  it("refuses a hard delete without --yes when stdin is not a TTY", () => {
    const { stderr, exitCode } = runCli(["admin", "feedback", "delete", "fb_x"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--yes");
  });

  it("exposes --undo on archive and --yes on delete", () => {
    const archiveHelp = runCli(["admin", "feedback", "archive", "--help"]);
    expect(archiveHelp.exitCode).toBe(0);
    expect(archiveHelp.stdout).toContain("--undo");

    const deleteHelp = runCli(["admin", "feedback", "delete", "--help"]);
    expect(deleteHelp.exitCode).toBe(0);
    expect(deleteHelp.stdout).toContain("--yes");
  });
});
