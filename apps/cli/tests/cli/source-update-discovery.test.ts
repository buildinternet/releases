import { describe, it, expect } from "bun:test";
import { runCli } from "../utils.js";

/**
 * Surface coverage for `releases admin source update --discovery` (buildinternet/releases#1317).
 *
 * Operators can promote/demote discovery status (curated | agent | on_demand)
 * on individual sources. The body assembly (`updates.discovery = opts.discovery`)
 * flows through the existing `updateSource(source, updates)` call; server
 * persistence ships in the companion monorepo PR.
 *
 * Local validation (rejection of unknown values) is asserted here because it
 * fires before any network call. Help-output tests confirm the option is
 * registered on the canonical `update` command.
 */
describe("admin source update --discovery (CLI surface)", () => {
  it("exposes --discovery on `source update`", () => {
    const { stdout, exitCode } = runCli(["admin", "source", "update", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--discovery <status>");
  });

  it("help text mentions valid values", () => {
    const { stdout, exitCode } = runCli(["admin", "source", "update", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("curated");
    expect(stdout).toContain("on_demand");
  });
});

describe("admin source update --discovery validation", () => {
  it("rejects an unknown discovery value before any API call", () => {
    const { stderr, exitCode } = runCli([
      "admin",
      "source",
      "update",
      "some-source",
      "--discovery",
      "bogus",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('"bogus"');
    // Confirm valid values are listed in the error
    expect(stderr).toContain("curated");
    expect(stderr).toContain("on_demand");
  });

  it("accepts 'curated' as a valid discovery value (no local validation error)", () => {
    // The command will fail at the network/findSource step with a fake URL, but
    // the local validator must not reject it.
    const { stderr } = runCli([
      "admin",
      "source",
      "update",
      "nonexistent-source-xyz",
      "--discovery",
      "curated",
    ]);
    expect(stderr).not.toContain("Invalid discovery");
    expect(stderr).not.toContain('"curated"');
  });

  it("accepts 'agent' as a valid discovery value (no local validation error)", () => {
    const { stderr } = runCli([
      "admin",
      "source",
      "update",
      "nonexistent-source-xyz",
      "--discovery",
      "agent",
    ]);
    expect(stderr).not.toContain("Invalid discovery");
  });

  it("accepts 'on_demand' as a valid discovery value (no local validation error)", () => {
    const { stderr } = runCli([
      "admin",
      "source",
      "update",
      "nonexistent-source-xyz",
      "--discovery",
      "on_demand",
    ]);
    expect(stderr).not.toContain("Invalid discovery");
  });
});
