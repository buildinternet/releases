import { describe, it, expect } from "bun:test";
import { runCli } from "../utils.js";

/**
 * #257 — surface coverage for `releases admin source reextract`. Behavioral
 * coverage (slug→ID resolution, dry-run default, snapshot body shape) lives in
 * tests/unit/reextract.test.ts.
 */
describe("source reextract (--help surface)", () => {
  it("requires a source identifier argument", () => {
    const { exitCode, stderr } = runCli(["admin", "source", "reextract"], {
      env: { RELEASES_API_URL: "https://test.example.com", RELEASES_API_KEY: "test" },
    });
    expect(exitCode).not.toBe(0);
    expect(stderr.toLowerCase()).toContain("identifier");
  });
});
