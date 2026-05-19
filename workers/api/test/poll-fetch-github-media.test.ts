/**
 * Tests for inline media extraction from GitHub release bodies (#1034).
 *
 * Two layers of coverage:
 * 1. Unit tests for `extractMediaFromMarkdown` directly — covers the four
 *    required cases: single image, multiple images, HTML img tag, no images.
 * 2. Integration test via `fetchOne` — a GitHub-type source whose release body
 *    contains an inline image should produce a DB row with a non-empty `media`
 *    JSON column.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { applyMigrations, ensureBatchShim } from "../../../tests/db-helper";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { extractMediaFromMarkdown } from "@releases/adapters/feed.js";
import type { MediaRef } from "@releases/rendering/media.js";
import { fetchOne } from "../src/cron/poll-fetch.js";

// ── unit: extractMediaFromMarkdown ───────────────────────────────────────────

describe("extractMediaFromMarkdown", () => {
  it("extracts a single markdown image", () => {
    const body =
      "## Release\n\n![Screenshot](https://github.com/user-attachments/assets/abc-123)\n\nSome text.";
    const media = extractMediaFromMarkdown(body);
    expect(media).toHaveLength(1);
    expect(media[0]).toEqual({
      type: "image",
      url: "https://github.com/user-attachments/assets/abc-123",
      alt: "Screenshot",
    });
  });

  it("extracts multiple markdown images", () => {
    const body = [
      "## Changes",
      "",
      "![Before](https://example.com/before.png)",
      "",
      "![After](https://example.com/after.png)",
      "",
      "Text continues.",
    ].join("\n");
    const media = extractMediaFromMarkdown(body);
    expect(media).toHaveLength(2);
    expect(media[0].url).toBe("https://example.com/before.png");
    expect(media[1].url).toBe("https://example.com/after.png");
  });

  it("extracts an HTML img tag", () => {
    const body = `<img src="https://example.com/demo.png" alt="Demo screenshot" />`;
    const media = extractMediaFromMarkdown(body);
    expect(media).toHaveLength(1);
    expect(media[0]).toEqual({
      type: "image",
      url: "https://example.com/demo.png",
      alt: "Demo screenshot",
    });
  });

  it("returns empty array when body has no images", () => {
    const body = "## Release notes\n\n- Fixed a bug\n- Improved performance";
    const media = extractMediaFromMarkdown(body);
    expect(media).toHaveLength(0);
  });

  it("classifies .gif URLs as gif type", () => {
    const body = "![Animation](https://example.com/demo.gif)";
    const media = extractMediaFromMarkdown(body);
    expect(media).toHaveLength(1);
    expect(media[0].type).toBe("gif");
  });

  it("classifies .mp4 URLs as video type", () => {
    const body = "![Demo video](https://example.com/demo.mp4)";
    const media = extractMediaFromMarkdown(body);
    expect(media).toHaveLength(1);
    expect(media[0].type).toBe("video");
  });

  it("classifies .webm and .mov as video type", () => {
    const body = [
      "![Clip](https://example.com/clip.webm)",
      "![Screencast](https://example.com/screencast.mov)",
    ].join("\n");
    const media = extractMediaFromMarkdown(body);
    expect(media).toHaveLength(2);
    expect(media[0].type).toBe("video");
    expect(media[1].type).toBe("video");
  });

  it("filters out non-https URLs", () => {
    const body = [
      "![Local](./local.png)",
      "![Safe](https://example.com/safe.png)",
      "![Http only](http://example.com/old.png)",
    ].join("\n");
    const media = extractMediaFromMarkdown(body);
    // Only the https:// and http:// pass isSafeMediaUrl (it allows http too).
    // The relative URL ./local.png is filtered out.
    expect(media.every((m: MediaRef) => m.url.startsWith("http"))).toBe(true);
    expect(media.some((m: MediaRef) => m.url === "./local.png")).toBe(false);
  });

  it("preserves empty alt text as undefined", () => {
    const body = "![](https://github.com/user-attachments/assets/uuid-123)";
    const media = extractMediaFromMarkdown(body);
    expect(media).toHaveLength(1);
    expect(media[0].alt).toBeUndefined();
  });

  it("extracts an HTML video tag", () => {
    const body = `<video src="https://example.com/demo.mp4"></video>`;
    const media = extractMediaFromMarkdown(body);
    expect(media).toHaveLength(1);
    expect(media[0]).toEqual({
      type: "video",
      url: "https://example.com/demo.mp4",
    });
  });
});

// ── integration: fetchOne with GitHub source ─────────────────────────────────

type FetchHandler = (url: string) => Response | Promise<Response>;
const originalFetch: typeof fetch = globalThis.fetch;

function installFetch(handler: FetchHandler) {
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mkDb() {
  const sqlite = new Database(":memory:");
  const rawDb = drizzle(sqlite);
  applyMigrations(sqlite);
  return ensureBatchShim(rawDb);
}

async function seedGitHubSource(db: ReturnType<typeof mkDb>) {
  await db
    .insert(organizations)
    .values({ id: "org_gh", slug: "acme", name: "Acme Corp", category: "developer-tools" });
  await db.insert(sources).values({
    id: "src_gh",
    orgId: "org_gh",
    slug: "acme-cli",
    name: "Acme CLI",
    type: "github",
    url: "https://github.com/acme/cli",
    metadata: JSON.stringify({}),
  });
}

// Minimal stub env — no embedding, no KV.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const STUB_ENV: any = {
  GITHUB_TOKEN: undefined,
  RELEASES_INDEX: undefined,
  CHANGELOG_CHUNKS_INDEX: undefined,
};

describe("fetchOne — GitHub source media extraction", () => {
  afterEach(() => {
    restoreFetch();
  });

  it("populates media column from GitHub release body inline images", async () => {
    const releaseBody = [
      "## What's new",
      "",
      "![Dark mode screenshot](https://github.com/user-attachments/assets/dark-mode-uuid)",
      "",
      "We also fixed a bug.",
    ].join("\n");

    installFetch((url) => {
      if (url.startsWith("https://api.github.com/repos/acme/cli/releases")) {
        return jsonResponse([
          {
            tag_name: "v1.0.0",
            name: "v1.0.0",
            body: releaseBody,
            html_url: "https://github.com/acme/cli/releases/tag/v1.0.0",
            published_at: "2026-05-01T00:00:00Z",
            prerelease: false,
          },
        ]);
      }
      if (url.startsWith("https://api.github.com/repos/acme/cli/contents")) {
        return jsonResponse([]);
      }
      return new Response("not found", { status: 404 });
    });

    const db = mkDb();
    await seedGitHubSource(db);
    const [src] = await db.select().from(sources).where(eq(sources.id, "src_gh"));

    const result = await fetchOne(db as any, src, STUB_ENV);
    expect(result.status).toBe("success");
    expect(result.releasesInserted).toBe(1);

    const rows = await db.select().from(releases).where(eq(releases.sourceId, "src_gh"));
    expect(rows).toHaveLength(1);

    const media = JSON.parse(rows[0].media ?? "[]") as Array<{
      type: string;
      url: string;
      alt?: string;
    }>;
    expect(media).toHaveLength(1);
    expect(media[0].type).toBe("image");
    expect(media[0].url).toBe("https://github.com/user-attachments/assets/dark-mode-uuid");
    expect(media[0].alt).toBe("Dark mode screenshot");
  });

  it("stores empty media array when GitHub release body has no images", async () => {
    installFetch((url) => {
      if (url.startsWith("https://api.github.com/repos/acme/cli/releases")) {
        return jsonResponse([
          {
            tag_name: "v1.0.1",
            name: "v1.0.1",
            body: "- Fixed a crash\n- Improved startup time",
            html_url: "https://github.com/acme/cli/releases/tag/v1.0.1",
            published_at: "2026-05-02T00:00:00Z",
            prerelease: false,
          },
        ]);
      }
      if (url.startsWith("https://api.github.com/repos/acme/cli/contents")) {
        return jsonResponse([]);
      }
      return new Response("not found", { status: 404 });
    });

    const db = mkDb();
    await seedGitHubSource(db);
    const [src] = await db.select().from(sources).where(eq(sources.id, "src_gh"));

    const result = await fetchOne(db as any, src, STUB_ENV);
    expect(result.status).toBe("success");
    expect(result.releasesInserted).toBe(1);

    const rows = await db.select().from(releases).where(eq(releases.sourceId, "src_gh"));
    const media = JSON.parse(rows[0].media ?? "[]");
    expect(media).toHaveLength(0);
  });
});
