import { describe, expect, it } from "bun:test";
import { runCli } from "../utils.js";

const publicEnv = {
  RELEASED_API_URL: "",
  RELEASED_API_KEY: "",
  RELEASES_API_URL: "",
  RELEASES_API_KEY: "",
};

describe("releases changelog", () => {
  it("is a public command in --help", () => {
    const { stdout, exitCode } = runCli(["--help"], { env: publicEnv });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("changelog");
  });

  it("prints help with examples", () => {
    const { stdout, exitCode } = runCli(["changelog", "--help"], { env: publicEnv });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("releases changelog");
    expect(stdout).toContain("Examples:");
    expect(stdout).toContain("releases changelog --json");
    expect(stdout).toContain("--limit");
  });

  it("rejects a non-positive --limit without hitting the API", () => {
    const { stderr, stdout, exitCode } = runCli(["changelog", "--limit", "0"], { env: publicEnv });
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Invalid limit");
    expect(stdout).not.toContain("What's new");
  });

  it("rejects a limit above the cap", () => {
    const { stderr, exitCode } = runCli(["changelog", "--limit", "999"], { env: publicEnv });
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("50 or less");
  });

  it("emits a structured JSON error for a bad --limit", () => {
    const { stdout, exitCode } = runCli(["changelog", "--json", "--limit", "999"], {
      env: publicEnv,
    });
    expect(exitCode).not.toBe(0);
    const parsed = JSON.parse(stdout) as {
      error: { kind: string; field?: string; message: string };
    };
    expect(parsed.error.kind).toBe("invalid_input");
    expect(parsed.error.field).toBe("limit");
    expect(parsed.error.message).toContain("50 or less");
  });
});
