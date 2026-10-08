import { describe, it, expect } from "bun:test";
import { runCli } from "../utils.js";

/**
 * #273 — surface coverage for `releases admin source fetch --local`. The
 * preflight gate, URL discovery, and brief shape are covered behaviorally in
 * tests/unit/{content-signal,page-discovery,fetch-local}.test.ts.
 */
describe("source fetch --local (surface + guards)", () => {
  it("advertises --local and --force in help", () => {
    const { stdout, exitCode } = runCli(["admin", "source", "fetch", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--local");
    expect(stdout).toContain("--force");
    expect(stdout).toContain("local-ingest");
  });

  it("requires a single source identifier with --local", () => {
    const { exitCode, stderr } = runCli(["admin", "source", "fetch", "--local"]);
    expect(exitCode).not.toBe(0);
    expect(stderr.toLowerCase()).toContain("single source identifier");
  });

  it("rejects --local combined with --org (single-source only)", () => {
    const { exitCode, stderr } = runCli([
      "admin",
      "source",
      "fetch",
      "my-source",
      "--local",
      "--org",
      "acme",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--org");
  });

  it("rejects --local combined with the --changed batch filter", () => {
    const { exitCode, stderr } = runCli([
      "admin",
      "source",
      "fetch",
      "my-source",
      "--local",
      "--changed",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--changed");
  });
});
