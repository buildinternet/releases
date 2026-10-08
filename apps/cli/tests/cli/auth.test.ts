import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { runCli } from "../utils.js";

let serverProc: ChildProcess | null = null;
let baseUrl = "";
let dataDir = "";

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "rel-authcli-"));

  // The stub API runs as a SEPARATE OS process, not an in-process Bun.serve:
  // runCli() uses spawnSync (blocking), so an in-process server's fetch handler
  // could never run while a CLI call is in flight (the test thread is parked in
  // spawnSync waiting for a response it's supposed to send — a deadlock). It
  // binds an ephemeral port (port: 0), reported via the READY line so parallel
  // CI runs never collide.
  const serverScript = `
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/v1/tokens/me") {
      const auth = req.headers.get("authorization") ?? "";
      if (auth !== "Bearer relk_good_token") return new Response("{}", { status: 401 });
      return Response.json({ kind: "token", name: "laptop", scopes: ["read", "write"] });
    }
    // Catalog page-based pagination shape, so \`admin source list\` runs to
    // completion (exits 0) after clearing the admin-key gate.
    return Response.json({
      items: [],
      pagination: { page: 1, pageSize: 50, returned: 0, totalItems: 0, totalPages: 0, hasMore: false },
    });
  },
});
process.stdout.write("READY:" + server.port + "\\n");
// Cap our own lifetime as a deterministic backstop: a detached child can
// outlive a dropped/again-dropped cleanup signal on a CI runner, and that
// stranded server is what hung the test job. The suite runs in ~1s, far
// under this, so self-exit only fires if cleanup never reached us.
setTimeout(() => process.exit(0), 30000);
`;
  const scriptPath = join(dataDir, "stub-server.ts");
  writeFileSync(scriptPath, serverScript);

  serverProc = spawn("bun", [scriptPath], {
    // stderr ignored so the only pipe is stdout (we read the port off it once,
    // then drop it below). detached + unref() is the documented child_process
    // pattern for a background test server — without unref the test-runner
    // worker waits on this child forever, which is what hung CI for 6h.
    stdio: ["ignore", "pipe", "ignore"],
    detached: true,
  });

  // Wait until the server is ready and capture the ephemeral port it bound.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("stub server start timeout")), 5000);
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

  // Port captured: release the last pipe and unref so the test-runner worker
  // can exit without waiting on this helper.
  serverProc.stdout?.destroy();
  serverProc.unref();
});

afterAll(() => {
  // SIGKILL, not the default SIGTERM: it can't be ignored, so cleanup can't be
  // dropped the way TERM was on the GitHub runner. The child's own self-exit
  // timer is the final backstop if even this doesn't reach it.
  serverProc?.kill("SIGKILL");
  serverProc = null;
  rmSync(dataDir, { recursive: true, force: true });
});

const env = () => ({
  RELEASED_API_KEY: "",
  RELEASED_API_URL: baseUrl,
  RELEASED_DATA_DIR: dataDir,
  RELEASED_TELEMETRY_DISABLED: "1",
});

describe("releases auth (e2e)", () => {
  it("login --token verifies and stores the credential", () => {
    const r = runCli(["auth", "login", "--token", "relk_good_token"], { env: env() });
    expect(r.exitCode).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/Verified/);
    expect(existsSync(join(dataDir, "credentials"))).toBe(true);
  });

  it("token prints the stored token", () => {
    const r = runCli(["auth", "token"], { env: env() });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("relk_good_token");
  });

  it("status --json reports authenticated + file source", () => {
    const r = runCli(["auth", "status", "--json"], { env: env() });
    const body = JSON.parse(r.stdout) as {
      authenticated: boolean;
      source: string;
      scopes: string[];
    };
    expect(body.authenticated).toBe(true);
    expect(body.source).toBe("file");
    expect(body.scopes).toEqual(["read", "write"]);
  });

  it("login rejects a bad token without saving", () => {
    const bad = mkdtempSync(join(tmpdir(), "rel-authbad-"));
    const r = runCli(["auth", "login", "--token", "relk_bad"], {
      env: {
        RELEASED_API_KEY: "",
        RELEASED_API_URL: baseUrl,
        RELEASED_DATA_DIR: bad,
        RELEASED_TELEMETRY_DISABLED: "1",
      },
    });
    expect(r.exitCode).toBe(1);
    expect(existsSync(join(bad, "credentials"))).toBe(false);
    rmSync(bad, { recursive: true, force: true });
  });

  it("an admin command is allowed with a stored write-capable token", () => {
    const r = runCli(["admin", "source", "list"], { env: env() });
    // Not blocked by the admin-key gate (stored token present)…
    expect(r.stderr).not.toMatch(/requires an API key/);
    // …and the command actually ran to completion past the gate.
    expect(r.exitCode).toBe(0);
  });

  it("logout removes the stored token", () => {
    const r = runCli(["auth", "logout"], { env: env() });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(dataDir, "credentials"))).toBe(false);
  });
});
