import { describe, it, expect } from "bun:test";
import { runCli } from "../utils.js";

/**
 * CLI surface coverage for the `admin overview` subcommand restructure (#715
 * + verb-rename PR #113). Hitting --help is enough — the action handlers
 * make network calls, which the harness can't reach.
 */

describe("admin overview subcommand group", () => {
  it("exposes the canonical subcommands", () => {
    const { stdout, exitCode } = runCli(["admin", "overview", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("get");
    expect(stdout).toContain("list");
    expect(stdout).toContain("plan");
    expect(stdout).toContain("inputs");
    expect(stdout).toContain("update");
  });

  it("`overview get --help` documents the read form", () => {
    const { stdout, exitCode } = runCli(["admin", "overview", "get", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Read an organization's AI overview");
  });

  it("`overview list --help` exposes the new manifest filters", () => {
    const { stdout, exitCode } = runCli(["admin", "overview", "list", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--stale-days");
    expect(stdout).toContain("--missing");
    expect(stdout).toContain("--has-activity");
    // Legacy flags preserved for back-compat
    expect(stdout).toContain("--stale");
    expect(stdout).toContain("--stale-min-releases");
  });

  it("`overview plan --help` documents action and needsFetch hints", () => {
    const { stdout, exitCode } = runCli(["admin", "overview", "plan", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--stale-days");
    expect(stdout).toContain("--missing");
    expect(stdout).toContain("--has-activity");
    expect(stdout).toContain("action");
    expect(stdout).toContain("needsFetch");
  });

  it("`overview inputs --help` exposes --check", () => {
    const { stdout, exitCode } = runCli(["admin", "overview", "inputs", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--check");
    expect(stdout).toContain("Pre-flight only");
  });

  it("`overview inputs --help` documents --max-content-chars and the Bash-stdout-cap motivation", () => {
    const { stdout, exitCode } = runCli(["admin", "overview", "inputs", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--max-content-chars");
    expect(stdout).toContain("stdout cap");
  });

  it("`overview update --help` requires --content-file", () => {
    const { stdout, exitCode } = runCli(["admin", "overview", "update", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--content-file");
  });

  it("`overview update --help` exposes --citations-file", () => {
    const { stdout, exitCode } = runCli(["admin", "overview", "update", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--citations-file");
    expect(stdout).toContain("startIndex");
  });

  it("`overview update --help` documents --unescape-html as a default no-op (#229)", () => {
    const { stdout, exitCode } = runCli(["admin", "overview", "update", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--unescape-html");
    const flat = stdout.replace(/\s+/g, " ");
    expect(flat).toContain("no-op");
  });

  it("`overview --help` no longer lists the retired batch subcommand", () => {
    const { stdout, exitCode } = runCli(["admin", "overview", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("batch");
  });
});

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
