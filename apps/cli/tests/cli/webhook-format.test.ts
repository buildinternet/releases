import { describe, it, expect } from "bun:test";
import { runCli } from "../utils.js";

describe("webhook --format discord", () => {
  it("documents discord on webhook add --help", () => {
    const { stdout, exitCode } = runCli(["webhook", "add", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--format");
    expect(stdout).toContain("discord");
    expect(stdout).toContain("slack");
    expect(stdout).toContain("JSON signing key shown once");
    expect(stdout).toContain("Slack/Discord");
    expect(stdout).toContain("URL as the secret");
    expect(stdout).not.toContain("signing key shown once)");
  });

  it("documents discord on webhook edit --help", () => {
    const { stdout, exitCode } = runCli(["webhook", "edit", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--format");
    expect(stdout).toContain("discord");
    expect(stdout).toContain("slack");
  });

  it("rejects an unknown --format before hitting the API", () => {
    const { stderr, exitCode } = runCli([
      "webhook",
      "add",
      "--org",
      "acme",
      "--url",
      "https://example.com/hook",
      "--format",
      "teams",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--format must be 'json', 'slack', or 'discord'");
  });
});
