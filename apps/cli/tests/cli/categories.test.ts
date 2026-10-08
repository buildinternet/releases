import { describe, it, expect } from "bun:test";
import { runCli } from "../utils.js";

describe("categories command", () => {
  it("lists categories", () => {
    const { stdout, exitCode } = runCli(["categories"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("ai");
    expect(stdout).toContain("cloud");
    expect(stdout).toContain("developer-tools");
  });

  it("supports --json flag", () => {
    const { stdout, exitCode } = runCli(["categories", "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toContain("ai");
  });
});
