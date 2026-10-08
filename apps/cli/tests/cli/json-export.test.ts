import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../utils.js";

// Top-level await import (module scope) — `runExport` calls getApiUrl() lazily,
// and fetch is stubbed per-test, so importing here is safe.
const { runExport } = await import("../../src/cli/commands/json.js");

/**
 * Coverage for `releases json export <org>` — reconstructs a releases.json v2
 * domain manifest from a tracked org by calling GET /v1/orgs/:slug/manifest
 * (buildinternet/releases). The success/404 paths stub global fetch and drive
 * `runExport` in-process (runCli can't mock fetch across a spawned child),
 * following the convention in json-validate.test.ts.
 */

describe("json export (public CLI integration)", () => {
  it("documents the command and its flags in help", () => {
    const { stdout, exitCode } = runCli(["json", "export", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("<org>");
    expect(stdout).toContain("--output");
    expect(stdout).toContain("releases.sh/docs/listing");
  });
});

function captureStdout() {
  const chunks: string[] = [];
  const orig = process.stdout.write;
  process.stdout.write = ((s: string) => {
    chunks.push(String(s));
    return true;
  }) as unknown as typeof process.stdout.write;
  return { chunks, restore: () => (process.stdout.write = orig) };
}

function mockFetchOnce(status: number, body: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      statusText: status === 404 ? "Not Found" : "OK",
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}

const VALID_MANIFEST = {
  version: 2,
  name: "Acme",
  category: "developer-tools",
  products: [{ name: "Acme API", slug: "acme-api", releases: [{ github: "acme/api" }] }],
  releases: [{ url: "https://acme.com/blog" }],
};

describe("json export <org> (backend reconstruction)", () => {
  let originalFetch: typeof globalThis.fetch;
  let exitSpy: ReturnType<typeof spyOn>;
  let exitCode: number | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    exitCode = undefined;
    exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCode = code;
      throw new Error("process.exit called");
    }) as never);
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    exitSpy.mockRestore();
  });

  it("prints the reconstructed manifest to stdout", async () => {
    mockFetchOnce(200, VALID_MANIFEST);
    const { chunks, restore } = captureStdout();
    try {
      await runExport("acme", {});
    } finally {
      restore();
    }
    // No error exit on the stdout path.
    expect(exitCode).toBeUndefined();
    const out = chunks.join("");
    const parsed = JSON.parse(out) as typeof VALID_MANIFEST;
    expect(parsed.version).toBe(2);
    expect(parsed.name).toBe("Acme");
    expect(parsed.products?.[0]?.releases).toEqual([{ github: "acme/api" }]);
  });

  it("exits 1 when the org is not tracked (404)", async () => {
    mockFetchOnce(404, { error: { message: "Organization not found" } });
    try {
      await runExport("does-not-exist", {});
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }
    expect(exitCode).toBe(1);
  });

  it("exits 1 on a generic non-OK response (500)", async () => {
    mockFetchOnce(500, { error: { message: "internal error" } });
    try {
      await runExport("acme", {});
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }
    expect(exitCode).toBe(1);
  });

  it("exits 1 when the response is not a v2 manifest (shape guard)", async () => {
    mockFetchOnce(200, { version: 3, name: "Wrong" });
    try {
      await runExport("acme", {});
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }
    expect(exitCode).toBe(1);
  });

  it("exits 1 when the network request throws", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    try {
      await runExport("acme", {});
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }
    expect(exitCode).toBe(1);
  });

  it("writes the manifest to a file with -o and keeps stdout clean", async () => {
    mockFetchOnce(200, VALID_MANIFEST);
    const out = join(tmpdir(), `releases-export-${process.pid}.json`);
    const { chunks, restore } = captureStdout();
    try {
      await runExport("acme", { output: out });
    } finally {
      restore();
    }
    expect(exitCode).toBeUndefined();
    // Nothing on stdout in file mode.
    expect(chunks.join("")).toBe("");
    const written = JSON.parse(readFileSync(out, "utf8")) as typeof VALID_MANIFEST;
    expect(written.version).toBe(2);
    expect(written.name).toBe("Acme");
    rmSync(out, { force: true });
  });
});
