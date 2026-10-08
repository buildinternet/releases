import { describe, it, expect } from "bun:test";
import { runCli } from "../utils.js";

/**
 * CLI-surface coverage for video source support (#1260). These exercise flags,
 * validation, the dry-run preview, and the generic-`create` redirect guard —
 * all of which short-circuit before any network call, so no API is needed.
 */
describe("source create-video --help", () => {
  it("documents the verb and its flags", () => {
    const { stdout, exitCode } = runCli(["admin", "source", "create-video", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--org");
    expect(stdout).toContain("--product");
    expect(stdout).toContain("--dry-run");
    expect(stdout).toContain("youtube.com");
  });
});

describe("source create-video validation", () => {
  it("rejects a non-video URL", () => {
    const { stdout, stderr, exitCode } = runCli([
      "admin",
      "source",
      "create-video",
      "https://example.com/changelog",
      "--org",
      "acme",
      "--dry-run",
    ]);
    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain("video URL");
  });

  it("requires --org", () => {
    const { stdout, stderr, exitCode } = runCli([
      "admin",
      "source",
      "create-video",
      "https://www.youtube.com/@AnthropicAI",
      "--dry-run",
    ]);
    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain("--org");
  });

  it("dry-run prints the planned request without creating", () => {
    const { stdout, stderr, exitCode } = runCli([
      "admin",
      "source",
      "create-video",
      "https://www.youtube.com/@AnthropicAI",
      "--org",
      "anthropic",
      "--dry-run",
    ]);
    expect(exitCode).toBe(0);
    const out = stdout + stderr;
    expect(out).toContain("dry-run");
    expect(out).toContain("/v1/sources/video");
    expect(out).toContain("orgSlug");
    expect(out).toContain("anthropic");
  });

  it("dry-run forwards a typed org_ id as orgId", () => {
    const { stdout, stderr, exitCode } = runCli([
      "admin",
      "source",
      "create-video",
      "https://www.youtube.com/@AnthropicAI",
      "--org",
      "org_abc123",
      "--dry-run",
    ]);
    expect(exitCode).toBe(0);
    const out = stdout + stderr;
    expect(out).toContain("orgId");
    expect(out).toContain("org_abc123");
  });
});

describe("source create rejects video inputs with a redirect", () => {
  it("rejects an explicit --type video", () => {
    const { stdout, stderr, exitCode } = runCli([
      "admin",
      "source",
      "create",
      "Anthropic",
      "--url",
      "https://example.com/x",
      "--type",
      "video",
    ]);
    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain("create-video");
  });

  it("rejects a pasted YouTube URL (auto-detected)", () => {
    const { stdout, stderr, exitCode } = runCli([
      "admin",
      "source",
      "create",
      "Anthropic",
      "--url",
      "https://www.youtube.com/@AnthropicAI",
    ]);
    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain("create-video");
  });
});
