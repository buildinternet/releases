import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { runCli } from "../utils.js";

/**
 * `releases keys`/`releases publish-token` now open a fresh device-flow
 * browser approval on EVERY invocation (see docs/architecture "one-shot
 * device session"). A manual run once launched the REAL default browser
 * (via `openBrowser` → `open`/`xdg-open`) because these commands had no
 * `--no-browser` escape hatch. This suite is deliberately conservative:
 * every case here passes `--no-browser` (or checks that the flag exists in
 * `--help`) — it never exercises the code path that would shell out to a
 * real browser opener, on this machine or in CI.
 */

let serverProc: ChildProcess | null = null;
let baseUrl = "";
let dataDir = "";

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "rel-keys-nobrowser-"));

  // Separate OS process — see tests/cli/auth.test.ts for why (runCli's
  // spawnSync blocks the test thread, so an in-process fetch handler would
  // deadlock against it).
  const serverScript = `
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/auth/device/code") {
      return Response.json({
        device_code: "dev123",
        user_code: "ABCD1234",
        verification_uri: "http://127.0.0.1:1/device",
        verification_uri_complete: "http://127.0.0.1:1/device?user_code=ABCD1234",
        expires_in: 900,
        interval: 0,
      });
    }
    if (url.pathname === "/api/auth/device/token") {
      return Response.json({ access_token: "sess_demo" });
    }
    if (url.pathname === "/api/auth/get-session") {
      return Response.json({ user: { email: "test@example.com", name: "Test" } });
    }
    if (url.pathname === "/api/auth/sign-out") {
      return Response.json({ ok: true });
    }
    if (url.pathname === "/v1/api-keys" && req.method === "GET") {
      return Response.json({ apiKeys: [] });
    }
    return new Response("not found", { status: 404 });
  },
});
process.stdout.write("READY:" + server.port + "\\n");
setTimeout(() => process.exit(0), 30000);
`;
  const scriptPath = join(dataDir, "stub-server.ts");
  writeFileSync(scriptPath, serverScript);

  serverProc = spawn("bun", [scriptPath], {
    stdio: ["ignore", "pipe", "ignore"],
    detached: true,
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("stub server start timeout")), 5000);
    let buf = "";
    serverProc!.stdout!.on("data", (d: Buffer) => {
      buf += d.toString();
      const m = buf.match(/READY:(\d+)/);
      if (m) {
        baseUrl = `http://127.0.0.1:${m[1]}`;
        clearTimeout(timer);
        resolve();
      }
    });
    serverProc!.on("error", (e: Error) => {
      clearTimeout(timer);
      reject(e);
    });
  });

  serverProc.stdout?.destroy();
  serverProc.unref();
});

afterAll(() => {
  serverProc?.kill("SIGKILL");
  serverProc = null;
  rmSync(dataDir, { recursive: true, force: true });
});

function env(): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "rel-keys-nobrowser-run-"));
  return {
    RELEASED_API_KEY: "",
    RELEASED_API_URL: baseUrl,
    RELEASED_DATA_DIR: dir,
    RELEASED_TELEMETRY_DISABLED: "1",
  };
}

describe("`--no-browser` on keys/publish-token", () => {
  it("is documented on every keys subcommand", () => {
    for (const args of [
      ["keys", "create", "--help"],
      ["keys", "list", "--help"],
      ["keys", "revoke", "--help"],
    ]) {
      const r = runCli(args);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("--no-browser");
    }
  });

  it("is documented on every publish-token subcommand", () => {
    for (const args of [
      ["publish-token", "create", "--help"],
      ["publish-token", "list", "--help"],
      ["publish-token", "revoke", "--help"],
    ]) {
      const r = runCli(args);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("--no-browser");
    }
  });

  it("`keys list --no-browser` completes the device flow without ever printing the real-browser branch", () => {
    const r = runCli(["keys", "list", "--no-browser"], { env: env() });
    expect(r.exitCode).toBe(0);
    const out = r.stdout + r.stderr;
    // The no-browser path skips BOTH the "opened" and "open this URL to
    // continue" branches entirely (openInBrowser is false) — only the plain
    // verify URL + code are printed.
    expect(out).not.toContain("Opening your browser");
    expect(out).not.toContain("Open this URL to continue");
    expect(out).not.toContain("Open this URL manually");
    expect(out).toContain("ABCD1234");
  });
});
