import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, spyOn } from "bun:test";
import { runCli } from "../utils.js";

/**
 * Integration coverage for `releases json validate` (releases-cli#351) — the
 * owner-facing validator for the releases.json v2 manifest. The local-file /
 * stdin paths are exercised via the real spawned CLI (runCli) — no network or
 * credential is touched there.
 *
 * The domain form now validates live against `POST /v1/listing/validate`
 * (buildinternet/releases#1910/#1947 phase 2, api-types 0.39.0). That path
 * can't be exercised via runCli (no way to mock fetch across a spawned child
 * process), so those cases drive `runValidate` in-process instead, following
 * the fetch-stubbing convention in tests/unit/api-client.test.ts.
 */

const VALID_DOMAIN = JSON.stringify({
  $schema: "https://releases.sh/schemas/releases.json",
  version: 2,
  name: "Acme Inc",
  category: "developer-tools",
  products: [
    {
      name: "Acme API",
      slug: "acme-api",
      releases: [{ url: "https://acme.com/changelog", canonical: true }],
    },
  ],
  registries: { "releases.sh": { org: "org_abc123", verification: "dns-txt-token" } },
});

const INVALID = JSON.stringify({
  version: 3,
  name: "Broken",
  releases: [{ url: "http://insecure.com/feed" }, { title: "no locator" }],
});

describe("json validate (public CLI integration)", () => {
  it("documents the command and its flags in help", () => {
    const { stdout, exitCode } = runCli(["json", "validate", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("<target>");
    expect(stdout).toContain("--json");
    expect(stdout).toContain("releases.sh/docs/listing");
  });

  it("accepts a push-publish github locator", () => {
    const repoManifest = JSON.stringify({
      version: 2,
      product: { name: "CLI", slug: "cli" },
      releases: [{ github: "self", publish: "push", path: "CHANGELOG.md" }],
    });
    const { stdout, exitCode } = runCli(["json", "validate", "-"], { input: repoManifest });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("valid releases.json");
    expect(stdout).toContain("repo scope");
  });

  it("validates a repo-scope manifest from stdin", () => {
    const repoManifest = JSON.stringify({
      $schema: "https://releases.sh/schemas/releases.json",
      version: 2,
      product: { name: "CLI", slug: "cli" },
      releases: [{ github: "self" }],
    });
    const { stdout, exitCode } = runCli(["json", "validate", "-"], { input: repoManifest });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("valid releases.json");
    expect(stdout).toContain("repo scope");
    expect(stdout).toContain("cli");
  });

  it("validates a domain-scope manifest and reports --json summary", () => {
    const { stdout, exitCode } = runCli(["json", "validate", "-", "--json"], {
      input: VALID_DOMAIN,
    });
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as {
      valid: boolean;
      scope: string;
      summary: { scope: string; products: number; releaseLocations: number };
    };
    expect(parsed.valid).toBe(true);
    expect(parsed.scope).toBe("domain");
    expect(parsed.summary.products).toBe(1);
    expect(parsed.summary.releaseLocations).toBe(1);
  });

  it("reports schema violations with paths and exits non-zero (--json)", () => {
    const { stdout, exitCode } = runCli(["json", "validate", "-", "--json"], { input: INVALID });
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout) as {
      valid: boolean;
      scope: string;
      issues: { path: string; message: string }[];
    };
    expect(parsed.valid).toBe(false);
    expect(parsed.scope).toBe("domain");
    const paths = parsed.issues.map((i) => i.path);
    expect(paths).toContain("version");
    expect(paths).toContain("releases.0.url");
    expect(paths).toContain("releases.1");
  });

  it("rejects non-JSON input before schema validation", () => {
    const { stderr, exitCode } = runCli(["json", "validate", "-"], { input: "{ not json" });
    expect(exitCode).toBe(1);
    expect(stderr.toLowerCase()).toContain("not valid json");
  });
});

// ---------------------------------------------------------------------------
// Domain form — live validation against POST /v1/listing/validate.
//
// Set RELEASES_API_URL before any code calls getApiUrl() (it memoizes
// process-wide on first call). runValidate calls getApiUrl() lazily inside the
// domain branch, so this is safe even though other test files in the suite
// may also touch mode.ts.
// ---------------------------------------------------------------------------

const prevEnv: { url?: string } = {};
beforeAll(() => {
  prevEnv.url = process.env.RELEASES_API_URL;
  process.env.RELEASES_API_URL = "https://test.example.com";
});
afterAll(() => {
  if (prevEnv.url === undefined) delete process.env.RELEASES_API_URL;
  else process.env.RELEASES_API_URL = prevEnv.url;
});

const { runValidate } = await import("../../src/cli/commands/json.js");

// Capture both console.log (human output) and process.stdout.write (writeJson
// — the repo's machine-output helper writes to stdout directly, not console).
function captureLogs() {
  const logs: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  const errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  const origWrite = process.stdout.write;
  process.stdout.write = ((s: string) => {
    logs.push(String(s));
    return true;
  }) as unknown as typeof process.stdout.write;
  return {
    logs,
    restore: () => {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      process.stdout.write = origWrite;
    },
  };
}

function mockFetchOnce(status: number, body: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as any;
}

describe("json validate <domain> (live listing validation)", () => {
  let originalFetch: typeof globalThis.fetch;
  let exitSpy: ReturnType<typeof spyOn>;
  let exitCode: number | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    exitCode = undefined;
    exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCode = code;
      throw new Error("process.exit called");
    }) as any);
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    exitSpy.mockRestore();
  });

  it("prints a valid summary with locations and exits 0", async () => {
    mockFetchOnce(200, {
      valid: true,
      errors: [],
      domainStatus: "unlisted",
      identity: { name: "Acme Inc", slug: "acme-inc", domain: "acme.com" },
      products: [{ name: "Acme API", locationCount: 1 }],
      locations: [
        {
          locator: "https://acme.com/changelog.xml",
          kind: "feed",
          classification: "tier1-live",
          becomes: "a live github/feed source",
          productName: "Acme API",
        },
      ],
    });
    const { logs, restore } = captureLogs();
    try {
      await runValidate("acme.com", {});
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    } finally {
      restore();
    }
    expect(exitCode).toBe(0);
    const out = logs.join("\n");
    expect(out.toLowerCase()).toContain("valid");
    expect(out).toContain("acme.com");
    expect(out).toContain("Acme API");
    expect(out).toContain("https://acme.com/changelog.xml");
    expect(out).toContain("releases.sh/submit");
  });

  it("prints invalid-manifest errors and exits 1", async () => {
    mockFetchOnce(200, {
      valid: false,
      errors: [{ path: "products.0.releases", message: "at least one release locator required" }],
      domainStatus: "unlisted",
      locations: [],
    });
    const { logs, restore } = captureLogs();
    try {
      await runValidate("broken.com", {});
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    } finally {
      restore();
    }
    expect(exitCode).toBe(1);
    const out = logs.join("\n");
    expect(out).toContain("products.0.releases");
    expect(out).toContain("at least one release locator required");
    expect(out).toContain("releases.sh/docs/listing");
  });

  it("exits 1 cleanly on a 2xx response with an unparseable body", async () => {
    globalThis.fetch = (async () =>
      new Response("not json at all", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as any;
    const { logs, restore } = captureLogs();
    try {
      await runValidate("acme.com", {});
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    } finally {
      restore();
    }
    expect(exitCode).toBe(1);
    expect(logs.join("\n")).toContain("unreadable response");
  });

  it("prints a friendly retry message on 429 and exits 1", async () => {
    mockFetchOnce(429, {
      error: { code: "rate_limited", type: "rate_limit", message: "Too many requests" },
    });
    const { logs, restore } = captureLogs();
    try {
      await runValidate("acme.com", {});
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    } finally {
      restore();
    }
    expect(exitCode).toBe(1);
    const out = logs.join("\n").toLowerCase();
    expect(out).toContain("minute");
  });

  it("emits the raw result merged with target under --json, exit 0 when valid", async () => {
    mockFetchOnce(200, {
      valid: true,
      errors: [],
      domainStatus: "listed",
      org: { slug: "acme", name: "Acme Inc", webUrl: "https://releases.sh/acme" },
      identity: { name: "Acme Inc", slug: "acme-inc", domain: "acme.com" },
      products: [],
      locations: [],
    });
    const { logs, restore } = captureLogs();
    try {
      await runValidate("acme.com", { json: true });
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    } finally {
      restore();
    }
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.target).toBe("acme.com");
    expect(parsed.valid).toBe(true);
    expect(parsed.domainStatus).toBe("listed");
    expect(parsed.org.slug).toBe("acme");
  });

  it("emits a --json error result on non-2xx, exit 1", async () => {
    mockFetchOnce(500, {
      error: { code: "internal_error", type: "internal", message: "Something broke" },
    });
    const { logs, restore } = captureLogs();
    try {
      await runValidate("acme.com", { json: true });
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    } finally {
      restore();
    }
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.target).toBe("acme.com");
    expect(parsed.valid).toBe(false);
    expect(parsed.message).toContain("Something broke");
  });

  it("exits 1 with a clear message when fetch throws (network failure)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as any;
    const { logs, restore } = captureLogs();
    try {
      await runValidate("acme.com", {});
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    } finally {
      restore();
    }
    expect(exitCode).toBe(1);
  });
});
