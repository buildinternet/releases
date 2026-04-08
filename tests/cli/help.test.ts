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
  const publicEnv = { RELEASED_API_KEY: "" };

  it("shows public commands in help", () => {
    const { stdout } = runCli(["--help"], { env: publicEnv });
    expect(stdout).toContain("search");
    expect(stdout).toContain("latest");
    expect(stdout).toContain("list");
    expect(stdout).toContain("summary");
    expect(stdout).toContain("compare");
    expect(stdout).toContain("stats");
    expect(stdout).toContain("usage");
    expect(stdout).toContain("categories");
    expect(stdout).toContain("serve");
    expect(stdout).toContain("api");
  });

  it("does not show admin commands in public help", () => {
    const { stdout } = runCli(["--help"], { env: publicEnv });
    expect(stdout).not.toContain("Admin:");
    expect(stdout).not.toContain("onboard");
    expect(stdout).not.toContain("enrich");
    expect(stdout).not.toContain("Manage organizations");
  });

  it("blocks admin commands with a clear error", () => {
    for (const cmd of ["fetch", "onboard", "org", "enrich", "poll"]) {
      const { stderr, exitCode } = runCli([cmd], { env: publicEnv });
      expect(exitCode).toBe(1);
      expect(stderr).toContain(`"${cmd}" requires an API key`);
      expect(stderr).toContain("RELEASED_API_KEY");
    }
  });

  it("blocks admin commands via help subcommand", () => {
    const { stderr, exitCode } = runCli(["help", "fetch"], { env: publicEnv });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("requires an API key");
  });

  it("shows unknown command error for truly unknown commands", () => {
    const { stderr, exitCode } = runCli(["help", "nonexistent"], { env: publicEnv });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown command");
  });
});

describe("CLI command gating (admin mode)", () => {
  const adminEnv = { RELEASED_API_KEY: "test-key" };

  it("shows admin section in help", () => {
    const { stdout } = runCli(["--help"], { env: adminEnv });
    expect(stdout).toContain("Admin:");
    expect(stdout).toContain("onboard");
    expect(stdout).toContain("fetch");
    expect(stdout).toContain("org");
    expect(stdout).toContain("enrich");
  });

  it("allows admin subcommand help", () => {
    const { stdout, exitCode } = runCli(["fetch", "--help"], { env: adminEnv });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("fetch");
  });

  it("allows org subcommand help", () => {
    const { stdout, exitCode } = runCli(["org", "--help"], { env: adminEnv });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("org");
  });

  it("allows product subcommand help", () => {
    const { stdout, exitCode } = runCli(["product", "--help"], { env: adminEnv });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("product");
  });
});
