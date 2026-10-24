import { describe, it, expect } from "bun:test";
import { runCli } from "../utils.js";

/**
 * Coverage for the stub-tier org verbs (releases-cli#355, backend
 * buildinternet/releases#1947): the local --location validation that fires
 * before any network call. Registration is covered by
 * tests/unit/command-surface.test.ts.
 */

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
