import { describe, it, expect } from "bun:test";
import { runCli } from "../utils.js";

// These exercise the local-validation paths only — each errors (exit 1) before
// any API call, so they're deterministic against the test URL. #304

describe("tail/latest --limit + --cursor (#304)", () => {
  it("accepts --limit on `latest` (no longer an unknown option)", () => {
    // Resolves the flag, then fails at the API call (test URL) — but never with
    // an "unknown option" error.
    const { stderr } = runCli(["latest", "--limit", "100"]);
    expect(stderr).not.toContain("unknown option");
  });

  it("--help documents --limit as an alias for --count", () => {
    const { stdout, exitCode } = runCli(["tail", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--limit");
    expect(stdout).toContain("--count");
  });

  it("rejects a non-positive --limit", () => {
    const { stderr, exitCode } = runCli(["latest", "--limit", "0"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--count/--limit must be a positive integer");
  });

  it("rejects a non-numeric --count", () => {
    const { stderr, exitCode } = runCli(["latest", "--count", "abc"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--count/--limit must be a positive integer");
  });

  it("--cursor without --product is rejected", () => {
    const { stderr, exitCode } = runCli(["latest", "--cursor", "abc"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--cursor only applies with --product");
  });

  it("--cursor with --follow is rejected", () => {
    const { stderr, exitCode } = runCli([
      "latest",
      "--product",
      "vercel/turborepo",
      "--cursor",
      "abc",
      "--follow",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--cursor can't be combined with --follow");
  });
});
