import { describe, it, expect } from "bun:test";
import { runCli } from "../utils.js";

/**
 * Coverage for #103 workstream 3 and Phase 2 (#119):
 * --notes-file / --parse-instructions-file are the only supported forms.
 * The deprecated inline --notes / --parse-instructions flags were removed in
 * Phase 2 and now exit non-zero as unknown options.
 *
 * Behavioral coverage uses --help and commander's unknown-option path because
 * exercising the full flow requires HTTP mocks (per the convention
 * documented in idempotent-create.test.ts).
 */

describe("admin playbook --notes-file (#103 ws3)", () => {
  const adminEnv = { RELEASED_API_KEY: "test-key" };

  it("documents --notes-file in --help", () => {
    const { stdout, exitCode } = runCli(["admin", "playbook", "--help"], { env: adminEnv });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--notes-file");
  });

  it("does not document removed --notes flag in --help", () => {
    const { stdout, exitCode } = runCli(["admin", "playbook", "--help"], { env: adminEnv });
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("--notes <text>");
  });

  it("exits non-zero with unknown option error for removed --notes flag", () => {
    const { stderr, exitCode } = runCli(["admin", "playbook", "acme", "--notes", "x"], {
      env: adminEnv,
    });
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("unknown option '--notes'");
  });
});

describe("source update --parse-instructions-file (#103 ws3)", () => {
  const adminEnv = { RELEASED_API_KEY: "test-key" };

  it("documents --parse-instructions-file in update --help", () => {
    const { stdout, exitCode } = runCli(["admin", "source", "update", "--help"], { env: adminEnv });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--parse-instructions-file");
  });

  it("documents --parse-instructions-file in deprecated edit --help", () => {
    const { stdout, exitCode } = runCli(["admin", "source", "edit", "--help"], { env: adminEnv });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--parse-instructions-file");
  });

  it("does not document removed --parse-instructions flag in update --help", () => {
    const { stdout, exitCode } = runCli(["admin", "source", "update", "--help"], { env: adminEnv });
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("--parse-instructions <text>");
  });

  it("exits non-zero with unknown option error for removed --parse-instructions flag", () => {
    const { stderr, exitCode } = runCli(
      ["admin", "source", "update", "src_dummy", "--parse-instructions", "x"],
      { env: adminEnv },
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("unknown option '--parse-instructions'");
  });
});
