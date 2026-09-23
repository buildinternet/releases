/**
 * #1579: a manual POST /v1/sources/:id/fetch that inserts releases must
 * auto-trigger the generate-content fill pass (the same machinery as
 * POST /v1/workflows/generate-content) via waitUntil — gated on the org
 * `auto_generate_content` opt-in and fail-open on summarizer errors, so a
 * freshly-onboarded source lands display-ready instead of showing bare
 * titles until an operator runs the summarizer by hand.
 *
 * Uses an appstore source so the whole ingest path is driven through
 * `globalThis.fetch` (mirrors appstore-fetch-route.test.ts — no mock.module
 * on the feed adapter; that stub is process-global and leaks, see AGENTS.md).
 * The Anthropic origin is intercepted by the same fetch stub.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { sourceRoutes } from "../src/routes/sources.js";
import { createTestDb, createTestApp } from "./setup";
import { restoreGlobalFetch } from "../../../tests/global-fetch";

afterEach(() => {
  restoreGlobalFetch();
});

const LISTING = JSON.stringify({
  resultCount: 1,
  results: [
    {
      trackId: 324684580,
      bundleId: "com.spotify.client",
      trackName: "Spotify",
      version: "9.0.12",
      currentVersionReleaseDate: "2026-05-19T11:42:00Z",
      releaseNotes: "We fixed a bug where playback would stall on shuffled playlists.",
      trackViewUrl: "https://apps.apple.com/us/app/id324684580?uo=4",
      sellerName: "Spotify AB",
      primaryGenreName: "Music",
      artworkUrl512: "https://is1-ssl.mzstatic.com/a/512x512bb.jpg",
      screenshotUrls: [],
      ipadScreenshotUrls: [],
      minimumOsVersion: "13.0",
    },
  ],
});

// Tagged-text shape parseReleaseContent expects from the summarizer.
const SUMMARIZE_TEXT = [
  "<title>Spotify 9.0.12 fixes shuffled-playlist playback</title>",
  "<title_short>Playback fix</title_short>",
  "<summary>Fixes a stall when playing shuffled playlists.</summary>",
  "<empty>false</empty>",
  "<composition><bugs>1</bugs><features>0</features><enhancements>0</enhancements></composition>",
].join("");

function anthropicMessage(text: string): Response {
  return new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-haiku-4-5",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 100,
        output_tokens: 40,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

// Minimal STATUS_HUB DO stub — the :slug/fetch route emits a status event at
// the end via getStatusHub. Same shape used by the other fetch-route tests.
const statusHubStub = {
  idFromName: () => "stub-id",
  get: () => ({
    fetch: async () => new Response("ok", { status: 200 }),
  }),
};

async function seedAppStoreSource(db: ReturnType<typeof createTestDb>, opts: { autoGen: boolean }) {
  await db.insert(organizations).values({
    id: "org_s",
    name: "Spotify",
    slug: "spotify",
    autoGenerateContent: opts.autoGen,
  });
  await db.insert(sources).values({
    id: "src_s",
    name: "Spotify iOS",
    slug: "spotify-ios",
    type: "appstore",
    url: "https://apps.apple.com/us/app/id324684580",
    orgId: "org_s",
    metadata: JSON.stringify({
      appStore: { trackId: "324684580", platform: "ios", storefront: "us" },
    }),
  });
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** Stub fetch: iTunes lookup → canned listing; Anthropic origin → `anthropic`. */
function installFetch(anthropic: () => Response) {
  let anthropicCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = urlOf(input);
    if (url.includes("api.anthropic.com")) {
      anthropicCalls++;
      return anthropic();
    }
    return new Response(LISTING, { status: 200 });
  }) as typeof fetch;
  return { anthropicCount: () => anthropicCalls };
}

/** App wired with a waitUntil-collecting context so tests can await the fill pass. */
function mkApp(db: ReturnType<typeof createTestDb>) {
  const waited: Promise<unknown>[] = [];
  const app = createTestApp(db, [sourceRoutes], {
    env: {
      STATUS_HUB: statusHubStub,
      ANTHROPIC_API_KEY: { get: async () => "sk-ant-test-key" },
    },
    executionCtx: {
      waitUntil: (p: Promise<unknown>) => {
        waited.push(p);
      },
      passThroughOnException: () => {},
    } as unknown as ExecutionContext,
  });
  return { app, flush: () => Promise.all(waited) };
}

describe("POST /v1/sources/:id/fetch — post-fetch generate-content fill (#1579)", () => {
  it("summarizes inserted releases when the org has opted in", async () => {
    const db = createTestDb();
    await seedAppStoreSource(db, { autoGen: true });
    const stub = installFetch(() => anthropicMessage(SUMMARIZE_TEXT));
    const { app, flush } = mkApp(db);

    const res = await app(new Request("https://x.test/v1/sources/src_s/fetch", { method: "POST" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.fetched).toBe(true);
    expect(body.releasesInserted).toBe(1);

    // The fill pass runs post-response via waitUntil; drain it before asserting.
    await flush();

    expect(stub.anthropicCount()).toBe(1);
    const [row] = await db.select().from(releases).where(eq(releases.sourceId, "src_s"));
    expect(row.titleGenerated).toBe("Spotify 9.0.12 fixes shuffled-playlist playback");
    expect(row.titleShort).toBe("Playback fix");
    expect(row.summary).toBe("Fixes a stall when playing shuffled playlists.");
  });

  it("does nothing (no model call) when the org has not opted in", async () => {
    const db = createTestDb();
    await seedAppStoreSource(db, { autoGen: false });
    const stub = installFetch(() => anthropicMessage(SUMMARIZE_TEXT));
    const { app, flush } = mkApp(db);

    const res = await app(new Request("https://x.test/v1/sources/src_s/fetch", { method: "POST" }));
    expect(res.status).toBe(200);
    await flush();

    expect(stub.anthropicCount()).toBe(0);
    const [row] = await db.select().from(releases).where(eq(releases.sourceId, "src_s"));
    expect(row.titleGenerated).toBeNull();
    expect(row.summary).toBeNull();
  });

  it("fails open: a summarizer error never fails the fetch or the waitUntil chain", async () => {
    const db = createTestDb();
    await seedAppStoreSource(db, { autoGen: true });
    // 400 (not 5xx) so the Anthropic SDK doesn't retry-with-backoff in tests.
    installFetch(
      () =>
        new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error" } }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const { app, flush } = mkApp(db);

    const res = await app(new Request("https://x.test/v1/sources/src_s/fetch", { method: "POST" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.fetched).toBe(true);
    expect(body.releasesInserted).toBe(1);

    // Must resolve, not reject — the fill pass is fail-open end to end.
    await flush();

    const [row] = await db.select().from(releases).where(eq(releases.sourceId, "src_s"));
    expect(row.titleGenerated).toBeNull();
    expect(row.summary).toBeNull();
  });
});
