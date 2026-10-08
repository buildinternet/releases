import { describe, it, expect } from "bun:test";
import { runCli } from "../utils.js";

describe("CLI error handling", () => {
  it("exits with error for unknown command", () => {
    const { exitCode } = runCli(["nonexistent-command"]);
    expect(exitCode).not.toBe(0);
  });

  it("shows error for fetch without required args in remote mode", () => {
    // Remote mode requires a filter - bare fetch is blocked
    const { exitCode } = runCli(["admin", "source", "fetch"], {
      env: { RELEASED_API_URL: "https://example.com", RELEASED_API_KEY: "test" },
    });
    expect(exitCode).not.toBe(0);
  });
});
