import { describe, it, expect } from "bun:test";
import { runCli } from "../utils.js";

/**
 * #252 — surface coverage for `releases admin source backfill`. Behavioral
 * coverage (slug→ID resolution, dry-run default, body shape) lives in
 * tests/unit/backfill.test.ts.
 */
describe("source backfill (--help surface)", () => {
  it("requires a source identifier argument", () => {
    const { exitCode, stderr } = runCli(["admin", "source", "backfill"], {
      env: { RELEASED_API_URL: "https://test.example.com", RELEASED_API_KEY: "test" },
    });
    expect(exitCode).not.toBe(0);
    expect(stderr.toLowerCase()).toContain("identifier");
  });
});
