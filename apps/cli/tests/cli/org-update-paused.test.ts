import { describe, it, expect } from "bun:test";
import { runCli } from "../utils.js";

/**
 * Surface coverage for `releases admin org update --paused` (issue #178).
 *
 * The body assembly (`updates.fetchPaused = opts.paused`) is exercised end-to-end
 * by the API tests in the monorepo PR that landed `fetchPaused`. Here we only
 * assert that the flags are registered on both the canonical `update` and the
 * deprecated `edit` alias, so muscle-memory callers don't fail silently.
 */
describe("admin org update --paused (CLI surface)", () => {
  it("exposes --paused / --no-paused on `org update`", () => {
    const { stdout, exitCode } = runCli(["admin", "org", "update", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--paused");
    expect(stdout).toContain("--no-paused");
  });

  it("exposes --paused / --no-paused on the deprecated `org edit` alias", () => {
    const { stdout, exitCode } = runCli(["admin", "org", "edit", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--paused");
    expect(stdout).toContain("--no-paused");
  });
});
