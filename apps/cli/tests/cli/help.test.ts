import { describe, it, expect } from "bun:test";
import { runCli } from "../utils.js";

describe("CLI help", () => {
  it("shows help with --help", () => {
    const { stdout, exitCode } = runCli(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Commands:");
    expect(stdout).toContain("releases");
  });

  it("shows help with -h", () => {
    const { stdout, exitCode } = runCli(["-h"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Commands:");
  });

  it("shows list subcommand help", () => {
    const { stdout, exitCode } = runCli(["list", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("list");
  });

  it("shows search subcommand help", () => {
    const { stdout, exitCode } = runCli(["search", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("search");
  });
});

describe("CLI command gating (public mode)", () => {
  // Clear both URL and KEY (both prefixes) so the CLI falls back to the default
  // public URL and an inherited RELEASES_/RELEASED_ key can't leak through the
  // legacyEnv fallback and defeat the public-mode gate.
  const publicEnv = {
    RELEASED_API_URL: "",
    RELEASED_API_KEY: "",
    RELEASES_API_URL: "",
    RELEASES_API_KEY: "",
  };

  it("shows public commands in help", () => {
    const { stdout } = runCli(["--help"], { env: publicEnv });
    expect(stdout).toContain("search");
    expect(stdout).toContain("latest");
    expect(stdout).toContain("list");
    expect(stdout).toContain("stats");
    expect(stdout).toContain("categories");
    expect(stdout).toContain("changelog");
    expect(stdout).toContain("admin");
    // `summary` and `compare` are local-only AI tools — not shipped in OSS.
  });

  it("keeps admin workflows behind the admin entrypoint in public help", () => {
    const { stdout } = runCli(["--help"], { env: publicEnv });
    expect(stdout).not.toContain("Admin:");
    // Admin subgroups/subcommands must not surface as top-level entries. (Note:
    // the `admin` entry's own description mentions "onboarding", so we assert on
    // the `discovery` subgroup token rather than "onboard".)
    expect(stdout).not.toContain("discovery");
    expect(stdout).not.toContain("Manage organizations");
  });

  it("blocks admin commands with a clear error", () => {
    for (const args of [
      ["admin", "source", "fetch"],
      ["admin", "discovery", "onboard", "Acme"],
      ["admin", "org", "list"],
      ["admin", "source", "poll"],
    ]) {
      const { stderr, exitCode } = runCli(args, { env: publicEnv });
      expect(exitCode).toBe(1);
      expect(stderr).toContain(`"admin" requires an API key`);
      expect(stderr).toContain("RELEASES_API_KEY");
    }
  });

  it("allows browsing admin help without an API key", () => {
    const { stdout, exitCode } = runCli(["admin", "--help"], { env: publicEnv });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("source");
    expect(stdout).toContain("discovery");
  });

  it("shows unknown command error for truly unknown commands", () => {
    const { stderr, exitCode } = runCli(["help", "nonexistent"], { env: publicEnv });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown command");
  });
});

describe("CLI command gating (admin mode)", () => {
  const adminEnv = { RELEASED_API_KEY: "test-key" };

  it("shows the admin entrypoint in root help", () => {
    const { stdout } = runCli(["--help"], { env: adminEnv });
    expect(stdout).toContain("admin");
    expect(stdout).not.toContain("Admin:");
  });

  it("shows admin namespace help", () => {
    const { stdout, exitCode } = runCli(["admin", "--help"], { env: adminEnv });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("source");
    expect(stdout).toContain("org");
    expect(stdout).toContain("product");
  });

  it("allows admin source help", () => {
    const { stdout, exitCode } = runCli(["admin", "source", "fetch", "--help"], { env: adminEnv });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("fetch");
  });

  it("allows org subcommand help", () => {
    const { stdout, exitCode } = runCli(["admin", "org", "--help"], { env: adminEnv });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("org");
  });

  it("allows product subcommand help", () => {
    const { stdout, exitCode } = runCli(["admin", "product", "--help"], { env: adminEnv });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("product");
  });
});
