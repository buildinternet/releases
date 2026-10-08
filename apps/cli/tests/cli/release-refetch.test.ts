import { describe, it, expect } from "bun:test";
import { runCli } from "../utils.js";

describe("release refetch (--help surface)", () => {
  it("registers the refetch command with its flags", () => {
    const { stdout, exitCode } = runCli(["admin", "release", "refetch", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("<releaseId>");
    expect(stdout).toContain("--url");
    expect(stdout).toContain("--apply");
    expect(stdout).toContain("--json");
  });

  it("requires a release ID argument", () => {
    const { exitCode, stderr } = runCli(["admin", "release", "refetch"], {
      env: { RELEASES_API_URL: "https://test.example.com", RELEASES_API_KEY: "test" },
    });
    expect(exitCode).not.toBe(0);
    expect(stderr.toLowerCase()).toContain("releaseid");
  });

  it("rejects a non-rel_ ID with a friendly error and no network call", () => {
    const { exitCode, stderr } = runCli(["admin", "release", "refetch", "src_notarelease"], {
      env: { RELEASES_API_URL: "https://test.example.com", RELEASES_API_KEY: "test" },
    });
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Invalid release ID");
  });
});
