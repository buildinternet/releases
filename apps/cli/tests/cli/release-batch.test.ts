import { describe, it, expect } from "bun:test";
import { runCli } from "../utils.js";

describe("release batch flags (--help surface)", () => {
  it("exposes --file on release delete", () => {
    const { stdout, exitCode } = runCli(["admin", "release", "delete", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--file");
    expect(stdout).toContain("[ids...]");
  });

  it("exposes --file on release suppress", () => {
    const { stdout, exitCode } = runCli(["admin", "release", "suppress", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--file");
    expect(stdout).toContain("[ids...]");
  });

  it("exposes --file on release unsuppress", () => {
    const { stdout, exitCode } = runCli(["admin", "release", "unsuppress", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--file");
    expect(stdout).toContain("[ids...]");
  });
});
