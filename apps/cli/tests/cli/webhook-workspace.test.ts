import { describe, it, expect } from "bun:test";
import { runCli } from "../utils.js";

describe("workspace-owned webhooks (releases-cli#406)", () => {
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
