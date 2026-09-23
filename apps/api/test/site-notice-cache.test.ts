import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { siteNoticeRoutes } from "../src/routes/site-notice.js";
import { putStoredSiteNotice } from "../src/queries/site-settings.js";
import type { SiteNotice } from "@buildinternet/releases-core/site-notice";

/**
 * GET /site-notice tags only the public, *active* notice as shared-cacheable.
 * An admin-only draft (inactive) must never be tagged `public` — otherwise a
 * shared/edge cache could serve an admin's unpublished draft to anonymous
 * users for up to its max-age (#1800).
 */

let h: TestDatabase;

function secretBinding(value: string) {
  return { get: async () => value };
}

function app() {
  const a = new Hono();
  a.route("/", siteNoticeRoutes);
  const env = { DB: h.db, RELEASES_API_KEY: secretBinding("root-secret") } as unknown as Record<
    string,
    unknown
  >;
  return { a, env };
}

const BASE = "https://api.releases.sh";

function notice(active: boolean): SiteNotice {
  return {
    active,
    message: "Heads up",
    placement: "banner",
    color: "#0081e7",
    dismissible: true,
  };
}

beforeEach(() => {
  h = createTestDb();
});

afterEach(() => {
  h.cleanup?.();
});

describe("GET /site-notice cache headers", () => {
  it("tags the active public notice public, max-age=60", async () => {
    await putStoredSiteNotice(h.db, notice(true));
    const { a, env } = app();
    const res = await a.request(`${BASE}/site-notice`, {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60, stale-while-revalidate=300");
    const body = (await res.json()) as { notice: { message: string } | null };
    expect(body.notice?.message).toBe("Heads up");
  });

  it("hides a draft from anonymous callers (notice: null, never public)", async () => {
    await putStoredSiteNotice(h.db, notice(false));
    const { a, env } = app();
    const res = await a.request(`${BASE}/site-notice`, {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notice: unknown };
    expect(body.notice).toBeNull();
    // null payload takes the early return → no Cache-Control header at all.
    expect(res.headers.get("cache-control")).toBeNull();
  });

  it("serves a draft to an admin Bearer as private, no-store (never shared-cached)", async () => {
    await putStoredSiteNotice(h.db, notice(false));
    const { a, env } = app();
    const res = await a.request(
      `${BASE}/site-notice`,
      { headers: { Authorization: "Bearer root-secret" } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notice: { active: boolean } | null };
    expect(body.notice?.active).toBe(false);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });
});
