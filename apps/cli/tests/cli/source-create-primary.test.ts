import { describe, it, expect } from "bun:test";
import { runCli } from "../utils.js";

/**
 * #263 — surface coverage: `source create` exposes `--primary` so an org's
 * primary changelog can be set in one step. Behavioral coverage (the flag lands
 * as `isPrimary` in the create POST body) lives in
 * tests/unit/create-primary.test.ts.
 */
describe("source create --primary flag (--help surface)", () => {
  it("exposes --primary on source create --help", () => {
    const { stdout, exitCode } = runCli(["admin", "source", "create", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--primary");
  });
});
