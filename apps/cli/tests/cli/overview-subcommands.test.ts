import { describe, it, expect } from "bun:test";
import { runCli } from "../utils.js";

/**
 * Help-text coverage for the deprecated `admin overview` kebab aliases (#715 +
 * verb-rename PR #113). Subcommand and flag registration is covered by
 * tests/unit/command-surface.test.ts.
 */

describe("deprecated overview kebab aliases", () => {
  it("`overview-list --help` is marked deprecated", () => {
    const { stdout, exitCode } = runCli(["admin", "overview-list", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("(deprecated — use overview list)");
  });

  it("`overview-inputs --help` is marked deprecated", () => {
    const { stdout, exitCode } = runCli(["admin", "overview-inputs", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("(deprecated — use overview inputs)");
  });

  it("`overview-write --help` is marked deprecated", () => {
    const { stdout, exitCode } = runCli(["admin", "overview-write", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("(deprecated — use overview update)");
  });

  it("the bare `overview <org>` form is documented as deprecated in the group help", () => {
    const { stdout, exitCode } = runCli(["admin", "overview", "--help"]);
    expect(exitCode).toBe(0);
    // Help wraps the line at narrow widths — match the unwrapped fragment.
    const flat = stdout.replace(/\s+/g, " ");
    expect(flat).toContain("deprecated; use 'overview get <org>'");
  });
});
