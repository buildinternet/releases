import { describe, it, expect } from "bun:test";
import { runCli } from "../utils.js";

/**
 * CLI-surface coverage for App Store source support (#247). These exercise
 * flags, validation, the dry-run preview, and the generic-`create` guard —
 * all of which short-circuit before any network call, so no API is needed.
 */
describe("source create-appstore --help", () => {
  it("documents the verb and its flags", () => {
    const { stdout, exitCode } = runCli(["admin", "source", "create-appstore", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--platform");
    expect(stdout).toContain("--org");
    expect(stdout).toContain("--product");
    expect(stdout).toContain("--storefront");
    expect(stdout).toContain("--dry-run");
    // Surfaces the pre-create-product workflow for clean names.
    expect(stdout).toContain("product create");
  });
});

describe("source create-appstore validation", () => {
  it("rejects an invalid --platform", () => {
    const { stdout, stderr, exitCode } = runCli([
      "admin",
      "source",
      "create-appstore",
      "618783545",
      "--platform",
      "windows",
      "--dry-run",
    ]);
    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain("platform");
  });

  it("rejects an unparseable identifier", () => {
    const { stdout, stderr, exitCode } = runCli([
      "admin",
      "source",
      "create-appstore",
      "not-an-id",
      "--dry-run",
    ]);
    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain("Could not parse");
  });

  it("dry-run prints the planned request (trackId) without creating", () => {
    const { stdout, stderr, exitCode } = runCli([
      "admin",
      "source",
      "create-appstore",
      "appstore:618783545",
      "--platform",
      "ios",
      "--org",
      "slack",
      "--dry-run",
    ]);
    expect(exitCode).toBe(0);
    const out = stdout + stderr;
    expect(out).toContain("dry-run");
    expect(out).toContain("trackId");
    expect(out).toContain("618783545");
  });
});

describe("source create rejects App Store inputs with a redirect", () => {
  it("rejects an explicit --type appstore", () => {
    const { stdout, stderr, exitCode } = runCli([
      "admin",
      "source",
      "create",
      "Slack",
      "--url",
      "https://example.com/x",
      "--type",
      "appstore",
    ]);
    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain("create-appstore");
  });

  it("rejects a pasted apps.apple.com URL (auto-detected)", () => {
    const { stdout, stderr, exitCode } = runCli([
      "admin",
      "source",
      "create",
      "Slack",
      "--url",
      "https://apps.apple.com/us/app/slack/id618783545",
    ]);
    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain("create-appstore");
  });
});
