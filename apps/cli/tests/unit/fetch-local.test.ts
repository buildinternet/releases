import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";

// Drive the real mode.ts via env. Use the suite-wide convention URL: getApiUrl()
// memoizes its base process-wide on first call, so a divergent value here would
// poison the cache for whatever client-mocking test runs after us. The mock
// routes API calls by path suffix, so the exact host is irrelevant to us anyway.
const prevEnv: { url?: string; key?: string } = {};
beforeAll(() => {
  prevEnv.url = process.env.RELEASES_API_URL;
  prevEnv.key = process.env.RELEASES_API_KEY;
  process.env.RELEASES_API_URL = "https://test.example.com";
  process.env.RELEASES_API_KEY = "test-key";
});
afterAll(() => {
  if (prevEnv.url === undefined) delete process.env.RELEASES_API_URL;
  else process.env.RELEASES_API_URL = prevEnv.url;
  if (prevEnv.key === undefined) delete process.env.RELEASES_API_KEY;
  else process.env.RELEASES_API_KEY = prevEnv.key;
});

const { runLocalHandoff } = await import("../../src/cli/commands/fetch-local.js");

const SOURCE = {
  id: "src_abc",
  slug: "my-changelog",
  type: "scrape",
  name: "My Changelog",
  url: "https://ex.com/changelog",
  orgId: "org_1",
};
const ORG = { id: "org_1", slug: "acme", name: "Acme" };

/**
 * Route by URL: the API host serves findSource/findOrg, ex.com serves
 * robots.txt + sitemap. The API routes match by path suffix because
 * `getApiUrl()` memoizes its base URL process-wide on first call (mode.ts),
 * so the host depends on whichever client-mocking test file ran first.
 * `robots` overrides the robots.txt body/status.
 */
function installFetch(robots: { body: string; status?: number }, sitemap?: string) {
  globalThis.fetch = (async (url: string) => {
    const u = String(url);
    if (u.endsWith("/v1/sources/src_abc")) return json(SOURCE);
    if (u.endsWith("/v1/orgs/org_1")) return json(ORG);
    if (u === "https://ex.com/robots.txt")
      return new Response(robots.body, {
        status: robots.status ?? 200,
        headers: { "Content-Type": "text/plain" },
      });
    if (u === "https://ex.com/sitemap.xml" && sitemap)
      return new Response(sitemap, { status: 200 });
    return new Response("", { status: 404 });
  }) as unknown as typeof globalThis.fetch;
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// Capture stdout (the brief) and stub process.exit (refuse/unknown call it).
function captureRun() {
  let out = "";
  const origWrite = process.stdout.write;
  const origLog = console.log;
  const origExit = process.exit;
  let exitCode: number | null = null;
  process.stdout.write = ((s: string) => {
    out += s;
    return true;
  }) as unknown as typeof process.stdout.write;
  console.log = (...a: unknown[]) => {
    out += a.join(" ") + "\n";
  };
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new ExitSignal();
  }) as unknown as typeof process.exit;
  return {
    out: () => out,
    exitCode: () => exitCode,
    restore: () => {
      process.stdout.write = origWrite;
      console.log = origLog;
      process.exit = origExit;
    },
  };
}
class ExitSignal extends Error {}

async function run(identifier: string, opts: { json?: boolean; force?: boolean }) {
  const cap = captureRun();
  try {
    await runLocalHandoff(identifier, opts);
  } catch (e) {
    if (!(e instanceof ExitSignal)) throw e;
  } finally {
    cap.restore();
  }
  return { out: cap.out(), exitCode: cap.exitCode() };
}

describe("runLocalHandoff", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("PROCEEDS: emits a JSON brief with the org-scoped batch endpoint and never POSTs to the MA", async () => {
    const sitemap = `<urlset>
      <url><loc>https://ex.com/changelog/v1</loc></url>
      <url><loc>https://ex.com/changelog/v2</loc></url>
    </urlset>`;
    let posted = false;
    installFetch({ body: "User-agent: *\nDisallow:\n" }, sitemap);
    const baseFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && String(url).includes("/workflows/update")) posted = true;
      return baseFetch(url as unknown as string, init);
    }) as unknown as typeof globalThis.fetch;

    const { out, exitCode } = await run("src_abc", { json: true });
    const brief = JSON.parse(out);
    expect(exitCode).toBeNull(); // clean proceed returns normally (no process.exit)
    expect(brief.preflight.verdict).toBe("proceed");
    expect(brief.batchEndpoint).toBe("/v1/orgs/acme/sources/my-changelog/releases/batch");
    expect(brief.discovery.pageStructure).toBe("index");
    expect(brief.discovery.candidates).toEqual([
      "https://ex.com/changelog/v1",
      "https://ex.com/changelog/v2",
    ]);
    expect(brief.exitCode).toBe(0);
    expect(posted).toBe(false);
  });

  it("REFUSES conductor-style ai-input=no/ai-train=no and exits 1, with no discovery", async () => {
    installFetch({ body: "Content-Signal: ai-train=no, search=yes, ai-input=no\n" });
    const { out, exitCode } = await run("src_abc", { json: true });
    const brief = JSON.parse(out);
    expect(exitCode).toBe(1);
    expect(brief.preflight.verdict).toBe("refuse");
    expect(brief.preflight.blocked.toSorted()).toEqual(["ai-input=no", "ai-train=no"]);
    expect(brief.discovery).toBeNull();
    expect(brief.exitCode).toBe(1);
  });

  it("--force overrides the refusal: exit 0, discovery runs, forced flag set", async () => {
    const sitemap = `<urlset>
      <url><loc>https://ex.com/changelog/v1</loc></url>
      <url><loc>https://ex.com/changelog/v2</loc></url>
    </urlset>`;
    installFetch({ body: "Content-Signal: ai-input=no\n" }, sitemap);
    const { out, exitCode } = await run("src_abc", { json: true, force: true });
    const brief = JSON.parse(out);
    expect(exitCode).toBeNull();
    expect(brief.preflight.verdict).toBe("refuse");
    expect(brief.preflight.forced).toBe(true);
    expect(brief.exitCode).toBe(0);
    expect(brief.discovery).not.toBeNull();
  });

  it("UNKNOWN (robots unreadable) exits 2 but still surfaces a best-effort brief", async () => {
    installFetch({ body: "", status: 503 });
    const { out, exitCode } = await run("src_abc", { json: true });
    const brief = JSON.parse(out);
    expect(exitCode).toBe(2);
    expect(brief.preflight.verdict).toBe("unknown");
    expect(brief.exitCode).toBe(2);
    expect(brief.discovery).not.toBeNull(); // surfaced, not assumed
  });
});
