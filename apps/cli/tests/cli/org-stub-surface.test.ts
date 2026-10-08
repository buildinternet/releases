import { describe, it, expect } from "bun:test";
import { runCli } from "../utils.js";

/**
 * Surface coverage for the stub-tier org verbs (releases-cli#355, backend
 * buildinternet/releases#1947): registration, flags, and the local --location
 * validation that fires before any network call.
 */
describe("admin org stub verbs (CLI surface)", () => {
  it("registers create-stub with its flags", () => {
    const { stdout, exitCode } = runCli(["admin", "org", "create-stub", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--location <json>");
    expect(stdout).toContain("--from-file <path>");
    expect(stdout).toContain("--domain <domain>");
  });

  it("registers create-stub-from-domain with --dry-run", () => {
    const { stdout, exitCode } = runCli(["admin", "org", "create-stub-from-domain", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("<domain>");
    expect(stdout).toContain("--dry-run");
  });

  it("registers promote with --dry-run", () => {
    const { stdout, exitCode } = runCli(["admin", "org", "promote", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("<slug>");
    expect(stdout).toContain("--dry-run");
  });
});

describe("admin org create-stub --location validation", () => {
  it("rejects invalid JSON before any API call", () => {
    const { stderr, exitCode } = runCli([
      "admin",
      "org",
      "create-stub",
      "Example",
      "--location",
      "not-json",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Invalid --location");
  });

  it("rejects an object with no locator key before any API call", () => {
    const { stderr, exitCode } = runCli([
      "admin",
      "org",
      "create-stub",
      "Example",
      "--location",
      '{"title":"no locator"}',
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("locator key");
  });
});
