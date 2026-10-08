import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Drive the real mode.ts via env (a top-level mock.module leaks across files —
// see api-client.test.ts; getApiUrl() also memoizes its base process-wide).
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

const { createStubOrg, createStubOrgFromDomain, promoteOrg } =
  await import("../../src/api/orgs.js");
const { orgCreateStubAction, orgCreateStubFromDomainAction, orgPromoteAction } =
  await import("../../src/cli/commands/org-stub.js");

const STUB_ORG = {
  id: "org_abc",
  name: "Example",
  slug: "example",
  productCount: 1,
  locationCount: 2,
};

const PROMOTE_RESULT = {
  promoted: true,
  sourcesCreated: 2,
  sourcesMatched: 0,
  locatorsStamped: 2,
};

function mockFetch(status: number, payload: unknown) {
  const captured: { url: string; method: string; body: Record<string, unknown> | null } = {
    url: "",
    method: "",
    body: null,
  };
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    captured.url = url;
    captured.method = init?.method ?? "GET";
    captured.body = init?.body ? JSON.parse(String(init.body)) : null;
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return captured;
}

let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── Client wire contracts ─────────────────────────────────────────────────────

describe("stub-org clients", () => {
  it("createStubOrg POSTs the body to /v1/orgs/stub", async () => {
    const captured = mockFetch(201, STUB_ORG);
    const body = { name: "Example", releases: [{ url: "https://example.com/changelog" }] };
    const created = await createStubOrg(body);
    expect(captured.url).toBe("https://test.example.com/v1/orgs/stub");
    expect(captured.method).toBe("POST");
    expect(captured.body).toMatchObject(body);
    expect(created.locationCount).toBe(2);
  });

  it("createStubOrgFromDomain POSTs {domain} and carries dryRun as a query param", async () => {
    const captured = mockFetch(200, { created: false, skippedReason: "dry_run", plan: {} });
    await createStubOrgFromDomain("example.com", { dryRun: true });
    expect(captured.url).toBe("https://test.example.com/v1/orgs/stub-from-domain?dryRun=1");
    expect(captured.body).toEqual({ domain: "example.com" });
  });

  it("createStubOrgFromDomain omits the query param without dryRun", async () => {
    const captured = mockFetch(200, { created: true, orgId: "org_abc" });
    await createStubOrgFromDomain("example.com");
    expect(captured.url).toBe("https://test.example.com/v1/orgs/stub-from-domain");
  });

  it("promoteOrg POSTs to /v1/orgs/:slug/promote with dryRun as a query param", async () => {
    const captured = mockFetch(200, PROMOTE_RESULT);
    const result = await promoteOrg("example", { dryRun: true });
    expect(captured.url).toBe("https://test.example.com/v1/orgs/example/promote?dryRun=1");
    expect(captured.method).toBe("POST");
    expect(result.sourcesCreated).toBe(2);
  });

  it("surfaces the nested error envelope message on a non-2xx", async () => {
    mockFetch(409, {
      error: { code: "conflict", type: "conflict", message: "already exists" },
    });
    await expect(createStubOrg({ name: "Example" })).rejects.toThrow(/already exists/);
  });
});

// ── Command actions ───────────────────────────────────────────────────────────

async function captureStdout(run: () => Promise<void>): Promise<string> {
  let out = "";
  const spy = ((s: string) => {
    out += s;
    return true;
  }) as unknown as typeof process.stdout.write;
  const orig = process.stdout.write;
  process.stdout.write = spy;
  try {
    await run();
  } finally {
    process.stdout.write = orig;
  }
  return out;
}

describe("orgCreateStubAction", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rel-org-stub-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("assembles the body from flags and repeated --location JSON", async () => {
    const captured = mockFetch(201, STUB_ORG);
    await orgCreateStubAction("Example", {
      slug: "example",
      domain: "example.com",
      location: [
        '{"url":"https://example.com/changelog","canonical":true}',
        '{"github":"example/repo"}',
      ],
    });
    expect(captured.body).toMatchObject({
      name: "Example",
      slug: "example",
      domain: "example.com",
      releases: [
        { url: "https://example.com/changelog", canonical: true },
        { github: "example/repo" },
      ],
    });
  });

  it("reads --from-file (bare locations array) and appends --location flags", async () => {
    const captured = mockFetch(201, STUB_ORG);
    const file = join(dir, "locations.json");
    writeFileSync(file, JSON.stringify([{ feed: "https://example.com/feed.xml" }]));
    await orgCreateStubAction("Example", {
      location: ['{"url":"https://example.com/changelog"}'],
      fromFile: file,
    });
    expect(captured.body?.releases).toEqual([
      { feed: "https://example.com/feed.xml" },
      { url: "https://example.com/changelog" },
    ]);
  });

  it("reads --from-file (full body object) with explicit flags winning", async () => {
    const captured = mockFetch(201, STUB_ORG);
    const file = join(dir, "body.json");
    writeFileSync(
      file,
      JSON.stringify({
        name: "File Name",
        domain: "file.example.com",
        releases: [{ url: "https://example.com/changelog" }],
      }),
    );
    await orgCreateStubAction("Example", { location: [], fromFile: file, domain: "example.com" });
    expect(captured.body).toMatchObject({
      name: "Example",
      domain: "example.com",
      releases: [{ url: "https://example.com/changelog" }],
    });
  });

  it("--json emits the created org", async () => {
    mockFetch(201, STUB_ORG);
    const out = await captureStdout(() =>
      orgCreateStubAction("Example", { location: [], json: true }),
    );
    expect(JSON.parse(out)).toMatchObject({ slug: "example", locationCount: 2 });
  });
});

describe("orgCreateStubFromDomainAction", () => {
  it("threads --dry-run and marks the JSON payload", async () => {
    const captured = mockFetch(200, { created: false, skippedReason: "dry_run", plan: {} });
    const out = await captureStdout(() =>
      orgCreateStubFromDomainAction("example.com", { dryRun: true, json: true }),
    );
    expect(captured.url).toContain("?dryRun=1");
    expect(JSON.parse(out)).toMatchObject({ dryRun: true, skippedReason: "dry_run" });
  });

  it("--json emits the created result", async () => {
    mockFetch(200, { created: true, orgId: "org_abc", productCount: 0, locationCount: 3 });
    const out = await captureStdout(() =>
      orgCreateStubFromDomainAction("example.com", { json: true }),
    );
    expect(JSON.parse(out)).toMatchObject({ created: true, locationCount: 3 });
  });
});

describe("orgPromoteAction", () => {
  it("threads --dry-run through to the query param and marks JSON output", async () => {
    const captured = mockFetch(200, { ...PROMOTE_RESULT, promoted: false, plan: {} });
    const out = await captureStdout(() =>
      orgPromoteAction("example", { dryRun: true, json: true }),
    );
    expect(captured.url).toBe("https://test.example.com/v1/orgs/example/promote?dryRun=1");
    expect(JSON.parse(out)).toMatchObject({ dryRun: true });
  });

  it("--json emits the promote result", async () => {
    mockFetch(200, PROMOTE_RESULT);
    const out = await captureStdout(() => orgPromoteAction("example", { json: true }));
    expect(JSON.parse(out)).toMatchObject({ promoted: true, sourcesCreated: 2 });
  });

  it("handles the already-tracked no-op without throwing", async () => {
    mockFetch(200, {
      promoted: false,
      alreadyTracked: true,
      sourcesCreated: 0,
      sourcesMatched: 0,
      locatorsStamped: 0,
    });
    await orgPromoteAction("example", {});
  });
});
