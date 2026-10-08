import { describe, it, expect } from "bun:test";
import { runCli } from "../utils.js";

/**
 * `releases admin product list` with no org argument enumerates products
 * across every org (releases-cli#259) — closing the CLI↔MCP `list_catalog`
 * gap that blocked a cross-org `kind=sdk` audit. The org argument is now
 * optional; pagination flags (`--limit`/`--page`) are validated locally.
 *
 * Behavioral assertions stop at the network boundary: the suite runs against a
 * fake API URL, so the no-org path is verified by the *absence* of the old
 * "Please specify an organization" guard, not by inspecting a live response.
 */
describe("admin product list — org optional (#259)", () => {
  it("--help documents the optional org argument and pagination flags", () => {
    const { stdout, exitCode } = runCli(["admin", "product", "list", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("across all orgs");
    // commander wraps the argument description across lines, so assert on a
    // fragment that survives the wrap rather than the full sentence.
    expect(stdout).toContain("across every org");
    expect(stdout).toContain("--limit <n>");
    expect(stdout).toContain("--page <n>");
  });

  it("no longer rejects a missing org argument", () => {
    // Without an org it now proceeds to the API (which fails against the fake
    // URL). The contract under test is that the old local guard is gone.
    const { stderr } = runCli(["admin", "product", "list"]);
    expect(stderr).not.toContain("Please specify an organization");
  });

  it("rejects an unknown --kind before any API call", () => {
    const { stderr, exitCode } = runCli(["admin", "product", "list", "--kind", "nope"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('Invalid kind "nope"');
  });

  it("rejects a non-positive --limit before any API call", () => {
    const { stderr, exitCode } = runCli(["admin", "product", "list", "--limit", "0"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--limit must be a positive integer");
  });

  it("rejects a non-positive --page before any API call", () => {
    const { stderr, exitCode } = runCli(["admin", "product", "list", "--page", "-1"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--page must be a positive integer");
  });
});
