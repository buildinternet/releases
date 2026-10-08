import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { runCli } from "../utils.js";

/**
 * Guard tests for `admin overview inputs` when the API returns 404 (null).
 *
 * `on_demand` orgs resolve overview-inputs through the public org view, which
 * 404s for those orgs. `apiFetch` silently converts GET 404 → null, so any
 * field dereference on the result crashes with a TypeError. This test suite
 * verifies that both the `--check` path and the full-inputs path:
 *   1. do NOT throw / crash
 *   2. exit non-zero
 *   3. emit structured JSON error (--json) or a clear human message (plain)
 *
 * Addresses Bug 2 of buildinternet/releases#1316.
 */

let serverProc: ChildProcess | null = null;
let baseUrl = "";
let dataDir = "";

// Stub server: /v1/orgs/shopify returns a valid org; the overview/inputs
// endpoint returns 404 (simulating an on_demand org).
const SERVER_SCRIPT = `
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    // Resolve the org lookup so the action proceeds past the orgNotFound guard.
    if (url.pathname === "/v1/orgs/shopify") {
      return Response.json({ id: "org_shopify", slug: "shopify", name: "Shopify", description: null });
    }
    // overview/inputs (both plain and ?check=true) returns 404.
    if (url.pathname === "/v1/orgs/shopify/overview/inputs") {
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    }
    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
  },
});
process.stdout.write("READY:" + server.port + "\\n");
setTimeout(() => process.exit(0), 30_000);
`;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "rel-ov-null-"));

  const scriptPath = join(dataDir, "stub-server.ts");
  writeFileSync(scriptPath, SERVER_SCRIPT);

  serverProc = spawn("bun", [scriptPath], {
    stdio: ["ignore", "pipe", "ignore"],
    detached: true,
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("stub server start timeout")), 5_000);
    let buf = "";
    serverProc!.stdout!.on("data", (d: Buffer) => {
      buf += d.toString();
      const m = buf.match(/READY:(\d+)/);
      if (m) {
        baseUrl = `http://localhost:${m[1]}`;
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

function env() {
  return {
    RELEASES_API_URL: baseUrl,
    RELEASES_API_KEY: "test-key",
    RELEASED_API_URL: baseUrl,
    RELEASED_API_KEY: "test-key",
  };
}

describe("`admin overview inputs` — API returns 404 (on_demand org)", () => {
  it("exits non-zero and emits structured JSON error for `--json --max-content-chars`", () => {
    const r = runCli(
      ["admin", "overview", "inputs", "shopify", "--json", "--max-content-chars", "1000"],
      { env: env() },
    );
    // Must not crash with a TypeError
    expect(r.stderr).not.toContain("TypeError");
    // Must exit non-zero
    expect(r.exitCode).not.toBe(0);
    // Must emit a structured JSON error (not raw `null`)
    const body = JSON.parse(r.stdout) as { error: string; orgSlug: string };
    expect(body.error).toBe("not_found");
    expect(body.orgSlug).toBe("shopify");
  });

  it("exits non-zero and prints a human-readable message for `--check` (non-JSON)", () => {
    const r = runCli(["admin", "overview", "inputs", "shopify", "--check"], { env: env() });
    expect(r.stderr).not.toContain("TypeError");
    expect(r.exitCode).not.toBe(0);
    // Should emit a human-friendly message, not raw 'null'
    const combined = r.stdout + r.stderr;
    expect(combined).not.toBe("null");
    expect(combined.length).toBeGreaterThan(0);
  });

  it("exits non-zero and emits structured JSON error for `--check --json`", () => {
    const r = runCli(["admin", "overview", "inputs", "shopify", "--check", "--json"], {
      env: env(),
    });
    expect(r.stderr).not.toContain("TypeError");
    expect(r.exitCode).not.toBe(0);
    const body = JSON.parse(r.stdout) as { error: string; orgSlug: string };
    expect(body.error).toBe("not_found");
    expect(body.orgSlug).toBe("shopify");
  });

  it("exits non-zero and prints a human-readable message for plain inputs (non-JSON)", () => {
    const r = runCli(["admin", "overview", "inputs", "shopify"], { env: env() });
    expect(r.stderr).not.toContain("TypeError");
    expect(r.exitCode).not.toBe(0);
    const combined = r.stdout + r.stderr;
    expect(combined).not.toBe("null");
    expect(combined.length).toBeGreaterThan(0);
  });
});
