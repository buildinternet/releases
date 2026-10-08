import { describe, it, expect } from "bun:test";
import { runCli } from "../utils.js";

/**
 * Surface coverage for `releases admin org update --featured` (issue #253).
 *
 * The body assembly (`updates.featured = opts.featured`) reaches the API's
 * `PATCH /v1/orgs/:slug { featured }` write path, exercised by the monorepo
 * tests that landed the `featured` flag (buildinternet/releases#1274/#1275).
 * Here we only assert the flags are registered on both the canonical `update`
 * and the deprecated `edit` alias, so muscle-memory callers don't fail silently.
 */
describe("admin org update --featured (CLI surface)", () => {
  it("exposes --featured / --no-featured on `org update`", () => {
    const { stdout, exitCode } = runCli(["admin", "org", "update", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--featured");
    expect(stdout).toContain("--no-featured");
  });

  it("exposes --featured / --no-featured on the deprecated `org edit` alias", () => {
    const { stdout, exitCode } = runCli(["admin", "org", "edit", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--featured");
    expect(stdout).toContain("--no-featured");
  });
});
