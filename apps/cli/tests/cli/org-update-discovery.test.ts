import { describe, it, expect } from "bun:test";
import { runCli } from "../utils.js";

/**
 * Surface coverage for `releases admin org update --discovery` (buildinternet/releases#1317).
 *
 * Operators can promote/demote discovery status (curated | agent | on_demand).
 * The body assembly (`updates.discovery = opts.discovery`) flows through the
 * existing `updateOrg(found.slug, updates)` call; server persistence ships in
 * the companion monorepo PR. Until then, the server silently ignores the field.
 *
 * Local validation (rejection of unknown values) is asserted here because it
 * fires before any network call. Flag registration (on `update` and the
 * deprecated `edit` alias) is covered by tests/unit/command-surface.test.ts.
 */

describe("admin org update --discovery validation", () => {
  it("rejects an unknown discovery value before any API call", () => {
    const { stderr, exitCode } = runCli([
      "admin",
      "org",
      "update",
      "some-org",
      "--discovery",
      "bogus",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('"bogus"');
    // Confirm valid values are listed in the error
    expect(stderr).toContain("curated");
    expect(stderr).toContain("on_demand");
  });

  it("accepts every valid discovery value (no local validation error)", () => {
    // The command will fail at the network lookup step with a fake URL, but
    // the local validator must not reject any of the allowed values.
    for (const value of ["curated", "agent", "on_demand"]) {
      const { stderr } = runCli([
        "admin",
        "org",
        "update",
        "nonexistent-org-xyz",
        "--discovery",
        value,
      ]);
      expect(stderr).not.toContain("Invalid discovery");
    }
  });
});
