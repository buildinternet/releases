/**
 * Integration coverage for the GitHub-CHANGELOG fetch override (#831).
 *
 * A `scrape` source carrying `metadata.githubUrl` should fetch from the
 * GitHub releases API (not the docs page), emit release URLs that match the
 * docs anchor scheme so dedup against existing scrape rows lines up via
 * UNIQUE(source_id, url), and have its `source_changelog_files` row
 * populated by the inline refresh step.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { applyMigrations, ensureBatchShim } from "../../../tests/db-helper";
import {
  organizations,
  sources,
  releases,
  sourceChangelogFiles,
} from "@buildinternet/releases-core/schema";
import { fetchOne } from "../src/cron/poll-fetch.js";

// ── fetch mock ──────────────────────────────────────────────────────────────

type FetchHandler = (url: string) => Response | Promise<Response>;
const originalFetch: typeof fetch = globalThis.fetch;
const fetchedUrls: string[] = [];

function installFetch(handler: FetchHandler) {
  fetchedUrls.length = 0;
  (globalThis as { fetch: typeof fetch }).fetch = (async (
    input: RequestInfo | URL,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    fetchedUrls.push(url);
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
  const rawDb = drizzle(sqlite);
  applyMigrations(sqlite);
  return ensureBatchShim(rawDb);
}

async function seedOverrideSource(
  db: ReturnType<typeof mkDb>,
  metadata: Record<string, unknown> = {
    githubUrl: "https://github.com/anthropics/claude-code",
  },
) {
  await db
    .insert(organizations)
    .values({ id: "org_a", slug: "anthropic", name: "Anthropic", category: "ai" });
  await db.insert(sources).values({
    id: "src_a",
    orgId: "org_a",
    slug: "claude-code",
    name: "Claude Code",
    type: "scrape",
    url: "https://code.claude.com/docs/en/changelog",
    metadata: JSON.stringify(metadata),
  });
}

// Stub env — no embedding bindings, so the inline embed step is a no-op.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const STUB_ENV: any = {
  GITHUB_TOKEN: undefined,
  RELEASES_INDEX: undefined,
  CHANGELOG_CHUNKS_INDEX: undefined,
};

// ── tests ────────────────────────────────────────────────────────────────────

describe("fetchOne — metadata.githubUrl override", () => {
  afterEach(() => {
    restoreFetch();
  });

  it("hits the override repo's GitHub API and rewrites release URLs to the docs anchor", async () => {
    installFetch((url) => {
      // GitHub releases API for the override repo
      if (url === "https://api.github.com/repos/anthropics/claude-code/releases?per_page=100") {
        return json([
          {
            tag_name: "2.1.133",
            name: "v2.1.133",
            body: "## Fixes\n- something",
            html_url: "https://github.com/anthropics/claude-code/releases/tag/2.1.133",
            published_at: "2026-05-01T00:00:00Z",
            prerelease: false,
          },
          {
            tag_name: "2.1.132",
            name: "v2.1.132",
            body: "## Fixes\n- another",
            html_url: "https://github.com/anthropics/claude-code/releases/tag/2.1.132",
            published_at: "2026-04-30T00:00:00Z",
            prerelease: false,
          },
        ]);
      }
      // Repo root listing for the changelog-file refresh step
      if (url === "https://api.github.com/repos/anthropics/claude-code/contents/") {
        return json([{ name: "CHANGELOG.md", type: "file" }]);
      }
      if (
        url === "https://raw.githubusercontent.com/anthropics/claude-code/HEAD/CHANGELOG.md" ||
        url.endsWith("anthropics/claude-code/HEAD/CHANGELOG.md")
      ) {
        return text("# Changelog\n\n## 2.1.133\nFixes");
      }
      return new Response("not found", { status: 404 });
    });

    const db = mkDb();
    await seedOverrideSource(db);
    const [src] = await db.select().from(sources).where(eq(sources.id, "src_a"));

    const result = await fetchOne(db as any, src, STUB_ENV);

    expect(result.status).toBe("success");
    expect(result.releasesInserted).toBe(2);

    // Confirm the GitHub API was hit (not the docs site)
    expect(
      fetchedUrls.some((u) =>
        u.startsWith("https://api.github.com/repos/anthropics/claude-code/releases"),
      ),
    ).toBe(true);
    expect(fetchedUrls.some((u) => u.startsWith("https://code.claude.com/"))).toBe(false);

    // Inserted release URLs use the docs-anchor form (Mintlify default —
    // leading `v` stripped from the GitHub tag), not the GitHub tag URL.
    const rows = await db.select().from(releases).where(eq(releases.sourceId, "src_a"));
    const urls = rows.map((r) => r.url).toSorted();
    expect(urls).toEqual([
      "https://code.claude.com/docs/en/changelog#2-1-132",
      "https://code.claude.com/docs/en/changelog#2-1-133",
    ]);

    // CHANGELOG-file refresh fired and populated source_changelog_files
    const files = await db
      .select()
      .from(sourceChangelogFiles)
      .where(eq(sourceChangelogFiles.sourceId, "src_a"));
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("CHANGELOG.md");
    expect(files[0].content).toContain("Changelog");
  });

  it("dedups override-mode releases against pre-existing scrape-side rows by URL", async () => {
    // Pre-seed a release with the human-anchor URL the override path will synthesize.
    installFetch((url) => {
      if (url === "https://api.github.com/repos/anthropics/claude-code/releases?per_page=100") {
        return json([
          {
            tag_name: "2.1.133",
            name: "v2.1.133",
            body: "fresh content",
            html_url: "https://github.com/anthropics/claude-code/releases/tag/2.1.133",
            published_at: "2026-05-01T00:00:00Z",
            prerelease: false,
          },
        ]);
      }
      if (url === "https://api.github.com/repos/anthropics/claude-code/contents/") {
        return json([]);
      }
      return new Response("not found", { status: 404 });
    });

    const db = mkDb();
    await seedOverrideSource(db);

    await db.insert(releases).values({
      id: "rel_existing",
      sourceId: "src_a",
      version: "2.1.133",
      title: "v2.1.133",
      content: "",
      url: "https://code.claude.com/docs/en/changelog#2-1-133",
      publishedAt: "2026-05-01T00:00:00Z",
      contentHash: "abc",
    });

    const [src] = await db.select().from(sources).where(eq(sources.id, "src_a"));
    const result = await fetchOne(db as any, src, STUB_ENV);

    // onConflictDoNothing skips the duplicate URL; insertion count stays 0
    expect(result.releasesFound).toBe(1);
    expect(result.releasesInserted).toBe(0);

    const rows = await db.select().from(releases).where(eq(releases.sourceId, "src_a"));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("rel_existing");
  });

  it("honors a custom releaseUrlTemplate override", async () => {
    installFetch((url) => {
      if (url === "https://api.github.com/repos/anthropics/claude-code/releases?per_page=100") {
        return json([
          {
            tag_name: "2.1.133",
            name: "v2.1.133",
            body: "fresh",
            html_url: "https://github.com/anthropics/claude-code/releases/tag/2.1.133",
            published_at: "2026-05-01T00:00:00Z",
            prerelease: false,
          },
        ]);
      }
      if (url === "https://api.github.com/repos/anthropics/claude-code/contents/") {
        return json([]);
      }
      return new Response("not found", { status: 404 });
    });

    const db = mkDb();
    await seedOverrideSource(db, {
      githubUrl: "https://github.com/anthropics/claude-code",
      releaseUrlTemplate: "${sourceUrl}/release/${version}",
    });
    const [src] = await db.select().from(sources).where(eq(sources.id, "src_a"));

    await fetchOne(db as any, src, STUB_ENV);

    const rows = await db.select().from(releases).where(eq(releases.sourceId, "src_a"));
    expect(rows.map((r) => r.url)).toEqual([
      "https://code.claude.com/docs/en/changelog/release/2.1.133",
    ]);
  });
});
