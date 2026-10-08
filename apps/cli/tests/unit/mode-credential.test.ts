import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "rel-mode-"));
// The canonical name wins over the legacy one and bun autoloads the repo-root .env,
// so drop any inherited value before pointing the data dir at a temp dir.
delete process.env.RELEASES_DATA_DIR;
process.env.RELEASED_DATA_DIR = dir;

const { writeCredential, clearCredential } = await import("../../src/lib/credentials.js");
const { resolveCredential, isAuthenticated, getApiKey } = await import("../../src/lib/mode.js");

const prevApiKey = process.env.RELEASES_API_KEY;
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  if (prevApiKey === undefined) delete process.env.RELEASES_API_KEY;
  else process.env.RELEASES_API_KEY = prevApiKey;
});

beforeEach(() => {
  delete process.env.RELEASED_API_KEY;
  // The canonical name wins over RELEASED_API_KEY; clear an ambient one from
  // the developer's shell so these precedence checks stay hermetic.
  delete process.env.RELEASES_API_KEY;
  clearCredential();
});

describe("resolveCredential precedence", () => {
  it("none when nothing is configured", () => {
    const c = resolveCredential();
    expect(c.token).toBeNull();
    expect(c.source).toBe("none");
    expect(isAuthenticated()).toBe(false);
  });

  it("uses the stored file when present", () => {
    writeCredential({
      token: "relk_file_tok",
      name: "laptop",
      scopes: ["read"],
      apiUrl: "https://api.releases.sh",
      savedAt: "t",
    });
    const c = resolveCredential();
    expect(c.source).toBe("file");
    expect(c.token).toBe("relk_file_tok");
    expect(c.scopes).toEqual(["read"]);
    expect(getApiKey()).toBe("relk_file_tok");
  });

  it("env var wins over the stored file", () => {
    writeCredential({ token: "relk_file_tok", apiUrl: "u", savedAt: "t" });
    process.env.RELEASED_API_KEY = "env-key";
    const c = resolveCredential();
    expect(c.source).toBe("env");
    expect(c.token).toBe("env-key");
  });

  it("getApiKey throws when unauthenticated", () => {
    expect(() => getApiKey()).toThrow();
  });
});
