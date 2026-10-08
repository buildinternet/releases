import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../utils.js";

/**
 * `releases keys` / `releases publish-token` now open a fresh browser
 * approval per command (see docs/architecture "one-shot device session").
 * `--dry-run` must short-circuit BEFORE that approval — never touch the
 * network at all. We assert this by pointing RELEASED_API_URL at a port
 * nothing listens on: if `--dry-run` ever reached the device-code request,
 * the connection would be refused and the command would fail non-zero
 * instead of printing its dry-run preview.
 */
const UNROUTABLE_API_URL = "http://127.0.0.1:1";

function isolatedDir(): string {
  return mkdtempSync(join(tmpdir(), "rel-dryrun-"));
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function env(): Record<string, string> {
  const dir = isolatedDir();
  dirs.push(dir);
  return {
    RELEASED_API_KEY: "",
    RELEASED_API_URL: UNROUTABLE_API_URL,
    RELEASED_DATA_DIR: dir,
    RELEASED_TELEMETRY_DISABLED: "1",
  };
}

describe("keys/publish-token --dry-run never makes a device request", () => {
  it("`keys create --dry-run` prints the preview and exits 0 with no network call", () => {
    const r = runCli(["keys", "create", "--name", "test", "--dry-run"], { env: env() });
    expect(r.exitCode).toBe(0);
    expect(r.stdout + r.stderr).toContain("[dry-run]");
    expect(r.stdout + r.stderr).not.toMatch(/ECONNREFUSED|connect/i);
  });

  it("`keys create --dry-run --json` writes the wouldCreate payload to stdout", () => {
    const r = runCli(["keys", "create", "--name", "test", "--dry-run", "--json"], {
      env: env(),
    });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as { dryRun: boolean; wouldCreate: { name: string } };
    expect(parsed.dryRun).toBe(true);
    expect(parsed.wouldCreate.name).toBe("test");
  });

  it("`keys revoke --dry-run` prints the preview and exits 0 with no network call", () => {
    const r = runCli(["keys", "revoke", "ak_1", "--dry-run"], { env: env() });
    expect(r.exitCode).toBe(0);
    expect(r.stdout + r.stderr).toContain("[dry-run]");
  });

  it("`publish-token create --dry-run` prints the preview and exits 0 with no network call", () => {
    const r = runCli(["publish-token", "create", "--source", "src_abc", "--dry-run"], {
      env: env(),
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout + r.stderr).toContain("[dry-run]");
  });

  it("`publish-token revoke --dry-run` prints the preview and exits 0 with no network call", () => {
    const r = runCli(["publish-token", "revoke", "pt_1", "--dry-run"], { env: env() });
    expect(r.exitCode).toBe(0);
    expect(r.stdout + r.stderr).toContain("[dry-run]");
  });
});
