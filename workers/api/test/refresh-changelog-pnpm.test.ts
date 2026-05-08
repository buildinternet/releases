/**
 * Regression test for issue #823: refreshChangelogFile (cron path) must
 * discover pnpm-workspace.yaml packages just as the probe endpoint does.
 *
 * Before the fix, the worker duplicated only the package.json#workspaces
 * branch and silently ingested zero files for pnpm-only repos. Now both
 * paths share `discoverChangelogPaths` from @releases/adapters/github-discovery.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations } from "../../../tests/db-helper";
import { organizations, sources, sourceChangelogFiles } from "@buildinternet/releases-core/schema";
import { refreshChangelogFile } from "../src/cron/poll-fetch.js";

// ── fetch mock ──────────────────────────────────────────────────────────────

type FetchHandler = (url: string) => Response | Promise<Response>;
let originalFetch: typeof fetch;

function installFetch(handler: FetchHandler) {
  originalFetch = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = (async (
    input: RequestInfo | URL,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    return await handler(url);
  }) as typeof fetch;
}

function restoreFetch() {
  (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain" } });
}

// ── DB helpers ───────────────────────────────────────────────────────────────

function mkDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  applyMigrations(sqlite);
  return db;
}

async function seedOrgAndSource(db: ReturnType<typeof mkDb>, metadata?: string) {
  await db
    .insert(organizations)
    .values({ id: "org_a", slug: "pnpm-org", name: "Pnpm Org", category: "developer-tools" });
  await db.insert(sources).values({
    id: "src_a",
    orgId: "org_a",
    slug: "pnpm-repo",
    name: "pnpm Repo",
    type: "github",
    url: "https://github.com/owner/pnpm-repo",
    ...(metadata ? { metadata } : {}),
  });
}

// Minimal stub env — only CHANGELOG_CHUNKS_INDEX matters for the skipEmbed path.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const STUB_ENV: any = { CHANGELOG_CHUNKS_INDEX: undefined };

// ── tests ────────────────────────────────────────────────────────────────────

describe("refreshChangelogFile — pnpm-workspace.yaml support", () => {
  afterEach(() => {
    restoreFetch();
  });

  it("fetches per-package CHANGELOGs discovered via pnpm-workspace.yaml", async () => {
    installFetch((url) => {
      // Root directory listing — only pnpm-workspace.yaml (no package.json)
      if (url.endsWith("/repos/owner/pnpm-repo/contents/")) {
        return json([
          { name: "pnpm-workspace.yaml", type: "file" },
          { name: "packages", type: "dir" },
        ]);
      }
      // pnpm-workspace.yaml raw content
      if (url.includes("raw.githubusercontent.com/owner/pnpm-repo/HEAD/pnpm-workspace.yaml")) {
        return text("packages:\n  - 'packages/*'\n");
      }
      // packages/ directory listing — two sub-packages
      if (url.endsWith("/repos/owner/pnpm-repo/contents/packages")) {
        return json([
          { name: "core", type: "dir" },
          { name: "utils", type: "dir" },
        ]);
      }
      // per-package directory listings — each has a CHANGELOG.md
      if (url.endsWith("/repos/owner/pnpm-repo/contents/packages/core")) {
        return json([{ name: "CHANGELOG.md", type: "file" }]);
      }
      if (url.endsWith("/repos/owner/pnpm-repo/contents/packages/utils")) {
        return json([{ name: "CHANGELOG.md", type: "file" }]);
      }
      // raw file content
      if (url.includes("packages/core/CHANGELOG.md")) {
        return text("# core changelog");
      }
      if (url.includes("packages/utils/CHANGELOG.md")) {
        return text("# utils changelog");
      }
      return new Response("not found", { status: 404 });
    });

    const db = mkDb();
    await seedOrgAndSource(db);
    const [src] = db.select().from(sources).all();

    await refreshChangelogFile(db as any, src, undefined, STUB_ENV, { skipEmbed: true });

    const rows = db.select().from(sourceChangelogFiles).all();
    const paths = rows.map((r) => r.path).toSorted();
    expect(paths).toEqual(["packages/core/CHANGELOG.md", "packages/utils/CHANGELOG.md"]);
  });

  it("fetches root CHANGELOG plus pnpm packages when both exist", async () => {
    installFetch((url) => {
      if (url.endsWith("/repos/owner/pnpm-repo/contents/")) {
        return json([
          { name: "CHANGELOG.md", type: "file" },
          { name: "pnpm-workspace.yaml", type: "file" },
          { name: "packages", type: "dir" },
        ]);
      }
      if (url.includes("raw.githubusercontent.com/owner/pnpm-repo/HEAD/pnpm-workspace.yaml")) {
        return text("packages:\n  - 'packages/*'\n");
      }
      if (url.endsWith("/repos/owner/pnpm-repo/contents/packages")) {
        return json([{ name: "alpha", type: "dir" }]);
      }
      if (url.endsWith("/repos/owner/pnpm-repo/contents/packages/alpha")) {
        return json([{ name: "CHANGELOG.md", type: "file" }]);
      }
      if (url.includes("raw.githubusercontent.com/owner/pnpm-repo/HEAD/CHANGELOG.md")) {
        return text("# root");
      }
      if (url.includes("packages/alpha/CHANGELOG.md")) {
        return text("# alpha");
      }
      return new Response("not found", { status: 404 });
    });

    const db = mkDb();
    await seedOrgAndSource(db);
    const [src] = db.select().from(sources).all();

    await refreshChangelogFile(db as any, src, undefined, STUB_ENV, { skipEmbed: true });

    const rows = db.select().from(sourceChangelogFiles).all();
    const paths = rows.map((r) => r.path).toSorted();
    expect(paths).toEqual(["CHANGELOG.md", "packages/alpha/CHANGELOG.md"]);
  });

  it("honors metadata.changelogPaths override (probe/cron parity)", async () => {
    installFetch((url) => {
      if (url.endsWith("/repos/owner/pnpm-repo/contents/")) {
        return json([
          { name: "CHANGELOG.md", type: "file" },
          { name: "custom", type: "dir" },
        ]);
      }
      if (url.endsWith("/repos/owner/pnpm-repo/contents/custom")) {
        return json([{ name: "CHANGELOG.md", type: "file" }]);
      }
      if (url.includes("raw.githubusercontent.com/owner/pnpm-repo/HEAD/CHANGELOG.md")) {
        return text("# root");
      }
      if (url.includes("custom/CHANGELOG.md")) {
        return text("# custom");
      }
      return new Response("not found", { status: 404 });
    });

    const db = mkDb();
    await seedOrgAndSource(db, JSON.stringify({ changelogPaths: ["custom/CHANGELOG.md"] }));
    const [src] = db.select().from(sources).all();

    await refreshChangelogFile(db as any, src, undefined, STUB_ENV, { skipEmbed: true });

    const rows = db.select().from(sourceChangelogFiles).all();
    const paths = rows.map((r) => r.path).toSorted();
    // With an override, planner returns root + override entries only.
    expect(paths).toEqual(["CHANGELOG.md", "custom/CHANGELOG.md"]);
  });

  it("returns empty and writes no rows for a non-GitHub URL", async () => {
    const db = mkDb();
    await db
      .insert(organizations)
      .values({ id: "org_b", slug: "other", name: "Other", category: "developer-tools" });
    await db.insert(sources).values({
      id: "src_b",
      orgId: "org_b",
      slug: "not-github",
      name: "Not GitHub",
      type: "scrape",
      url: "https://example.com/not-a-github-repo",
    });
    const all = db.select().from(sources).all();
    const src = all.find((r) => r.id === "src_b")!;

    const result = await refreshChangelogFile(db as any, src, undefined, STUB_ENV, {
      skipEmbed: true,
    });

    expect(result.changedFiles).toHaveLength(0);
    const rows = db.select().from(sourceChangelogFiles).all();
    expect(rows).toHaveLength(0);
  });
});
