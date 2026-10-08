import { describe, it, expect } from "bun:test";
import { runCli } from "../utils.js";

/**
 * #1184 — surface coverage for the `--hard` purge flag on `release delete` and
 * `source delete`. Behavioral wire-contract coverage (the `?hard=true` query
 * param) lives in tests/unit/delete-hard.test.ts.
 */
describe("delete --hard (--help surface)", () => {
  it("exposes --hard on `release delete`", () => {
    const { stdout, exitCode } = runCli(["admin", "release", "delete", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--hard");
    expect(stdout).toContain("--source");
  });

  it("exposes --hard on `source delete`", () => {
    const { stdout, exitCode } = runCli(["admin", "source", "delete", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--hard");
  });
});
