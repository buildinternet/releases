import { describe, it, expect } from "bun:test";
import { runCli } from "../utils.js";

/**
 * #252 — surface coverage for `releases admin source backfill`. Behavioral
 * coverage (slug→ID resolution, dry-run default, body shape) lives in
 * tests/unit/backfill.test.ts.
 */
describe("source backfill (--help surface)", () => {
  it("registers the backfill command with its flags", () => {
    const { stdout, exitCode } = runCli(["admin", "source", "backfill", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--max-windows");
    expect(stdout).toContain("--no-dry-run");
    expect(stdout).toContain("--markdown-file");
    expect(stdout).toContain("--wait");
    expect(stdout).toContain("--json");
  });

  it("requires a source identifier argument", () => {
    const { exitCode, stderr } = runCli(["admin", "source", "backfill"], {
      env: { RELEASED_API_URL: "https://test.example.com", RELEASED_API_KEY: "test" },
    });
    expect(exitCode).not.toBe(0);
    expect(stderr.toLowerCase()).toContain("identifier");
  });

  it("registers backfill-status with an instanceId argument", () => {
    const { stdout, exitCode } = runCli(["admin", "source", "backfill-status", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("instanceId");
    expect(stdout).toContain("--json");
  });
});
