import { describe, it, expect } from "bun:test";
import { runCli } from "../utils.js";

describe("CLI help", () => {
  it("shows help with --help", () => {
    const { stdout, exitCode } = runCli(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("released");
  });

  it("shows help with -h", () => {
    const { stdout, exitCode } = runCli(["-h"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage:");
  });

  it("lists available commands in help", () => {
    const { stdout } = runCli(["--help"]);
    expect(stdout).toContain("fetch");
    expect(stdout).toContain("list");
    expect(stdout).toContain("search");
    expect(stdout).toContain("org");
    expect(stdout).toContain("latest");
  });

  it("shows fetch subcommand help", () => {
    const { stdout, exitCode } = runCli(["fetch", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("fetch");
  });

  it("shows org subcommand help", () => {
    const { stdout, exitCode } = runCli(["org", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("org");
  });

  it("shows list subcommand help", () => {
    const { stdout, exitCode } = runCli(["list", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("list");
  });

  it("shows product subcommand help", () => {
    const { stdout, exitCode } = runCli(["product", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("product");
  });

  it("shows search subcommand help", () => {
    const { stdout, exitCode } = runCli(["search", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("search");
  });
});
