import { describe, it, expect } from "bun:test";
import { runCli } from "../utils.js";

/**
 * Integration coverage for idempotent `org create` and `source create`.
 *
 * These tests exercise only CLI surface (flags, --help output) without hitting
 * a real API — the existing org/source lookup requires network access, so
 * we assert flag presence and --strict semantics via help output only.
 *
 * Behavioral smoke (org create twice, --strict second call) is covered in
 * the PR description and manual smoke tests.
 */
describe("idempotent org create (--strict flag)", () => {
  it("exposes --strict flag in org create --help", () => {
    const { stdout, exitCode } = runCli(["admin", "org", "create", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--strict");
  });

  it("exposes --strict flag in deprecated org add --help", () => {
    const { stdout, exitCode } = runCli(["admin", "org", "add", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--strict");
  });

  it("documents --tags on org create --help (reconciled on retry, see #116)", () => {
    const { stdout, exitCode } = runCli(["admin", "org", "create", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--tags");
  });
});

describe("idempotent source create (--strict flag)", () => {
  it("exposes --strict flag in source create --help", () => {
    const { stdout, exitCode } = runCli(["admin", "source", "create", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--strict");
  });

  it("exposes --strict flag in deprecated source add --help", () => {
    const { stdout, exitCode } = runCli(["admin", "source", "add", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--strict");
  });
});
