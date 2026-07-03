import { describe, it, expect, beforeEach, afterEach, beforeAll } from "bun:test";
import {
  revalidatedPaths,
  enableLocalAdminEnv,
  disableLocalAdminEnv,
  stubFetch,
  stubFetchReject,
  restoreFetch,
} from "./test-helpers";
import type { SiteNotice } from "@buildinternet/releases-core/site-notice";

// Loaded dynamically in beforeAll — see test-helpers.ts for why a static
// import of an action module here would race the server-only mock.
let setSiteNoticeAction: (typeof import("./site-notice"))["setSiteNoticeAction"];

const NOTICE: SiteNotice = {
  active: true,
  message: "Scheduled maintenance tonight.",
};

describe("setSiteNoticeAction", () => {
  beforeAll(async () => {
    ({ setSiteNoticeAction } = await import("./site-notice"));
  });

  beforeEach(() => {
    enableLocalAdminEnv();
    revalidatedPaths.length = 0;
  });

  afterEach(() => {
    restoreFetch();
  });

  it("happy path: PUT to /v1/site-notice with the admin bearer, revalidates the layout", async () => {
    const recorded = stubFetch([new Response(null, { status: 200 })]);

    const result = await setSiteNoticeAction(NOTICE);

    expect(result).toEqual({ ok: true });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.method).toBe("PUT");
    expect(recorded[0]?.url).toBe("http://api.test.local/v1/site-notice");
    expect(recorded[0]?.headers.authorization).toBe("Bearer test-admin-key");
    expect(recorded[0]?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(recorded[0]?.body ?? "null")).toEqual(NOTICE);
    expect(revalidatedPaths).toEqual(["/"]);
  });

  it("API error: maps a non-ok response to ok:false without revalidating", async () => {
    stubFetch([new Response(JSON.stringify({ error: { message: "Forbidden" } }), { status: 403 })]);

    const result = await setSiteNoticeAction(NOTICE);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("403");
    expect(revalidatedPaths).toEqual([]);
  });

  it("network error: fetch rejection maps to ok:false without revalidating", async () => {
    stubFetchReject(new Error("getaddrinfo ENOTFOUND"));

    const result = await setSiteNoticeAction(NOTICE);

    expect(result).toEqual({ ok: false, error: "getaddrinfo ENOTFOUND" });
    expect(revalidatedPaths).toEqual([]);
  });

  it("characterizes current behavior: gate closed throws via next/headers cookies() outside a request scope", async () => {
    disableLocalAdminEnv();
    const recorded = stubFetch([]);

    // With RELEASES_API_KEY unset, adminActionEnv() falls through to
    // mintUserJwt(), which unconditionally calls next/headers' cookies() to
    // read the caller's session — and cookies() throws outside a Next.js
    // request scope (there is no next/headers mock here on purpose; see
    // test-helpers.ts / the plan's Maintenance notes). This test pins that
    // observed behavior rather than asserting a graceful ActionResult.
    await expect(setSiteNoticeAction(NOTICE)).rejects.toThrow(
      "`cookies` was called outside a request scope",
    );
    expect(recorded).toHaveLength(0);
    expect(revalidatedPaths).toEqual([]);

    enableLocalAdminEnv();
  });
});
