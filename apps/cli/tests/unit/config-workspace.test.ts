import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { getWorkDir, getRunsDir, expandHome } from "@buildinternet/releases-lib/config";

// config caches the data dir lazily (on the first getDataDir() call, not at
// import), so a static import is safe as long as the env var is set before any
// of the helpers below run — which it is (top-level assignment, then tests).
const dir = mkdtempSync(join(tmpdir(), "rel-work-"));
// The canonical name wins over the legacy one and bun autoloads the repo-root .env,
// so drop any inherited value before pointing the data dir at a temp dir.
delete process.env.RELEASES_DATA_DIR;
process.env.RELEASED_DATA_DIR = dir;

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("maintenance workspace dirs", () => {
  it("getWorkDir returns <dataDir>/work and creates it", () => {
    const work = getWorkDir();
    expect(work).toBe(join(dir, "work"));
    expect(statSync(work).isDirectory()).toBe(true);
  });

  it("getRunsDir returns <dataDir>/work/runs and creates it", () => {
    const runs = getRunsDir();
    expect(runs).toBe(join(dir, "work", "runs"));
    expect(statSync(runs).isDirectory()).toBe(true);
  });
});

describe("expandHome", () => {
  it("expands a leading ~/ to the home dir", () => {
    expect(expandHome("~/x/y")).toBe(join(homedir(), "x", "y"));
  });

  it("expands a bare ~ to the home dir", () => {
    expect(expandHome("~")).toBe(homedir());
  });

  it("leaves absolute, relative, and ~user paths unchanged", () => {
    expect(expandHome("/abs/path")).toBe("/abs/path");
    expect(expandHome("relative/path")).toBe("relative/path");
    expect(expandHome("~user/x")).toBe("~user/x");
  });
});
