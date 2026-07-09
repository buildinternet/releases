#!/usr/bin/env bun
/**
 * Catalog smoke matrix for GraphQL-backed web routes (#2057).
 *
 * Hits stable public pages after deploy so PQ/deploy-window failures surface
 * without waiting for users. No secrets — public GETs only.
 *
 * Usage:
 *   bun scripts/smoke-catalog-web.ts
 *   BASE_URL=https://releases.sh bun scripts/smoke-catalog-web.ts
 *   BASE_URL=https://releases.sh API_URL=https://api.releases.sh bun scripts/smoke-catalog-web.ts
 *
 * Exit 0 when every path returns 2xx (after redirects). Exit 1 on any failure.
 *
 * Stable fixtures (prod catalog):
 *   /                              home
 *   /anthropic                     OrgPage
 *   /anthropic/releases            OrgReleases
 *   /anthropic/claude              ProductPage
 *   /anthropic/product-launches    SourceDetail
 *   /collections/coding-agents     CollectionPage
 *   /release/{id}                  ReleaseDetail (id resolved via public API)
 */

const DEFAULT_BASE_URL = "https://releases.sh";
const DEFAULT_API_URL = "https://api.releases.sh";
const USER_AGENT = "releases-smoke-catalog-web/1.0 (+https://github.com/buildinternet/releases)";
const REQUEST_TIMEOUT_MS = 30_000;

type SmokeCase = {
  /** Label for the table */
  name: string;
  /** Path or absolute URL relative to BASE_URL */
  path: string;
  /** Follow redirects (needed for bare /release/{id} → slug form) */
  followRedirects?: boolean;
};

const STATIC_CASES: SmokeCase[] = [
  { name: "home", path: "/" },
  { name: "org", path: "/anthropic" },
  { name: "org-releases", path: "/anthropic/releases" },
  { name: "product", path: "/anthropic/claude" },
  { name: "source", path: "/anthropic/product-launches" },
  { name: "collection", path: "/collections/coding-agents" },
];

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function deriveApiUrl(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    // https://releases.sh → https://api.releases.sh
    if (u.hostname === "releases.sh") {
      return "https://api.releases.sh";
    }
    // https://www.releases.sh → same
    if (u.hostname === "www.releases.sh") {
      return "https://api.releases.sh";
    }
  } catch {
    // fall through
  }
  return DEFAULT_API_URL;
}

function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

type Row = {
  name: string;
  path: string;
  status: string;
  ms: number;
  finalUrl: string;
  ok: boolean;
  error?: string;
};

async function resolveReleasePath(apiUrl: string): Promise<string> {
  const url = `${stripTrailingSlash(apiUrl)}/v1/orgs/anthropic/releases?limit=1`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`release fixture resolve failed: GET ${url} → ${res.status}`);
  }
  const body = (await res.json()) as { releases?: Array<{ id?: string }> };
  const id = body.releases?.[0]?.id;
  if (!id || typeof id !== "string") {
    throw new Error(`release fixture resolve failed: no releases[0].id from ${url}`);
  }
  return `/release/${id}`;
}

async function checkOne(baseUrl: string, c: SmokeCase): Promise<Row> {
  const target = c.path.startsWith("http")
    ? c.path
    : `${stripTrailingSlash(baseUrl)}${c.path.startsWith("/") ? c.path : `/${c.path}`}`;
  const start = performance.now();
  try {
    const res = await fetch(target, {
      method: "GET",
      redirect: c.followRedirects === false ? "manual" : "follow",
      headers: {
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // Drain body so keep-alive / connection reuse stays clean; we only care about status.
    await res.arrayBuffer().catch(() => undefined);
    const ms = Math.round(performance.now() - start);
    const ok = is2xx(res.status);
    return {
      name: c.name,
      path: c.path,
      status: String(res.status),
      ms,
      finalUrl: res.url || target,
      ok,
      error: ok ? undefined : `expected 2xx, got ${res.status}`,
    };
  } catch (err) {
    const ms = Math.round(performance.now() - start);
    const message = err instanceof Error ? err.message : String(err);
    return {
      name: c.name,
      path: c.path,
      status: "ERR",
      ms,
      finalUrl: target,
      ok: false,
      error: message,
    };
  }
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function printTable(rows: Row[]): void {
  const cols = {
    name: Math.max(4, ...rows.map((r) => r.name.length)),
    path: Math.max(4, ...rows.map((r) => r.path.length)),
    status: 6,
    ms: 6,
    result: 6,
  };
  const header =
    pad("NAME", cols.name) +
    "  " +
    pad("PATH", cols.path) +
    "  " +
    pad("STATUS", cols.status) +
    "  " +
    pad("MS", cols.ms) +
    "  " +
    pad("RESULT", cols.result);
  console.log(header);
  console.log("-".repeat(header.length));
  for (const r of rows) {
    console.log(
      pad(r.name, cols.name) +
        "  " +
        pad(r.path, cols.path) +
        "  " +
        pad(r.status, cols.status) +
        "  " +
        pad(String(r.ms), cols.ms) +
        "  " +
        (r.ok ? "PASS" : "FAIL"),
    );
    if (r.error) {
      console.log(`  └─ ${r.error}`);
    } else if (r.finalUrl && !r.finalUrl.endsWith(r.path) && r.path.startsWith("/release/")) {
      console.log(`  └─ → ${r.finalUrl}`);
    }
  }
}

async function main(): Promise<number> {
  const baseUrl = stripTrailingSlash(process.env.BASE_URL?.trim() || DEFAULT_BASE_URL);
  const apiUrl = stripTrailingSlash(
    process.env.API_URL?.trim() ||
      process.env.RELEASES_API_URL?.trim() ||
      process.env.RELEASED_API_URL?.trim() ||
      deriveApiUrl(baseUrl),
  );

  console.log(`Catalog web smoke → ${baseUrl}`);
  console.log(`API (release fixture) → ${apiUrl}`);
  console.log("");

  const cases: SmokeCase[] = [...STATIC_CASES];

  try {
    const releasePath = await resolveReleasePath(apiUrl);
    cases.push({
      name: "release",
      path: releasePath,
      followRedirects: true,
    });
    console.log(`Resolved release fixture: ${releasePath}`);
    console.log("");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to resolve release fixture: ${message}`);
    // Still run static cases, then fail overall.
    cases.push({
      name: "release",
      path: "/release/UNRESOLVED",
    });
  }

  const rows: Row[] = [];
  for (const c of cases) {
    if (c.path === "/release/UNRESOLVED") {
      rows.push({
        name: c.name,
        path: c.path,
        status: "ERR",
        ms: 0,
        finalUrl: "",
        ok: false,
        error: "could not resolve release id from public API",
      });
      continue;
    }
    rows.push(await checkOne(baseUrl, c));
  }

  printTable(rows);
  console.log("");

  const failed = rows.filter((r) => !r.ok);
  if (failed.length === 0) {
    console.log(`OK — ${rows.length}/${rows.length} paths returned 2xx`);
    return 0;
  }
  console.error(`FAIL — ${failed.length}/${rows.length} path(s) failed`);
  return 1;
}

const code = await main();
process.exit(code);
