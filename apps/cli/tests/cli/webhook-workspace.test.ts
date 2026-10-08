import { describe, it, expect } from "bun:test";
import { runCli } from "../utils.js";

describe("workspace-owned webhooks (releases-cli#406)", () => {
  it("documents --workspace on webhook list/add/show/edit/remove/test/rotate-secret", () => {
    for (const cmd of ["list", "add", "show", "edit", "remove", "test", "rotate-secret"]) {
      const { stdout, exitCode } = runCli(["webhook", cmd, "--help"]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("--workspace <id-or-slug>");
    }
  });

  it("documents `releases workspace list` in help", () => {
    const { stdout, exitCode } = runCli(["workspace", "list", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--json");
  });

  it("rejects `webhook add --scope follows --workspace …` before any request", () => {
    const { stderr, exitCode } = runCli([
      "webhook",
      "add",
      "--url",
      "https://example.com/hook",
      "--scope",
      "follows",
      "--workspace",
      "ws_doesnotmatter",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Workspace webhooks are org-scoped only");
  });
});
