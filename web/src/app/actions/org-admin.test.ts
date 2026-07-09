import { describe, it, expect, beforeEach, afterEach, beforeAll } from "bun:test";
import {
  revalidatedPaths,
  enableLocalAdminEnv,
  disableLocalAdminEnv,
  stubFetch,
  stubFetchReject,
  restoreFetch,
} from "./test-helpers.test";

// Loaded dynamically in beforeAll — see test-helpers.test.ts for why a static
// import of an action module here would race the server-only mock.
let setOrgHiddenAction: (typeof import("./org-admin"))["setOrgHiddenAction"];
let setOrgAutoGenerateContentAction: (typeof import("./org-admin"))["setOrgAutoGenerateContentAction"];
let setOrgFeaturedAction: (typeof import("./org-admin"))["setOrgFeaturedAction"];
let setOrgNoticeAction: (typeof import("./org-admin"))["setOrgNoticeAction"];
let renameOrgAction: (typeof import("./org-admin"))["renameOrgAction"];
let setOrgFetchPausedAction: (typeof import("./org-admin"))["setOrgFetchPausedAction"];
let setOrgOverviewCadenceDaysAction: (typeof import("./org-admin"))["setOrgOverviewCadenceDaysAction"];

describe("org-admin actions", () => {
  beforeAll(async () => {
    ({
      setOrgHiddenAction,
      setOrgAutoGenerateContentAction,
      setOrgFeaturedAction,
      setOrgNoticeAction,
      renameOrgAction,
      setOrgFetchPausedAction,
      setOrgOverviewCadenceDaysAction,
    } = await import("./org-admin"));
  });

  beforeEach(() => {
    enableLocalAdminEnv();
    revalidatedPaths.length = 0;
  });

  afterEach(() => {
    restoreFetch();
  });

  describe("setOrgHiddenAction", () => {
    it("happy path: PATCH /v1/orgs/:slug with isHidden, revalidates / and /:slug", async () => {
      const recorded = stubFetch([new Response(null, { status: 200 })]);

      const result = await setOrgHiddenAction({ slug: "acme", hidden: true });

      expect(result).toEqual({ ok: true });
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.method).toBe("PATCH");
      expect(recorded[0]?.url).toBe("http://api.test.local/v1/orgs/acme");
      expect(recorded[0]?.headers.authorization).toBe("Bearer test-admin-key");
      expect(JSON.parse(recorded[0]?.body ?? "null")).toEqual({ isHidden: true });
      expect(revalidatedPaths).toEqual(["/", "/acme", "/acme/admin"]);
    });

    it("API error: maps a non-ok response to ok:false without revalidating", async () => {
      stubFetch([new Response("Forbidden", { status: 403, statusText: "Forbidden" })]);

      const result = await setOrgHiddenAction({ slug: "acme", hidden: true });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("403");
      expect(revalidatedPaths).toEqual([]);
    });

    it("network error: fetch rejection maps to ok:false without revalidating", async () => {
      stubFetchReject(new Error("network down"));

      const result = await setOrgHiddenAction({ slug: "acme", hidden: true });

      expect(result).toEqual({ ok: false, error: "network down" });
      expect(revalidatedPaths).toEqual([]);
    });

    it("gate closed: no admin credential returns an env error (characterizes current behavior)", async () => {
      disableLocalAdminEnv();
      const recorded = stubFetch([]);

      await expect(setOrgHiddenAction({ slug: "acme", hidden: true })).rejects.toThrow(
        "`cookies` was called outside a request scope",
      );
      expect(recorded).toHaveLength(0);

      enableLocalAdminEnv();
    });
  });

  describe("setOrgAutoGenerateContentAction", () => {
    it("happy path: PATCH /v1/orgs/:slug with autoGenerateContent, revalidates only /:slug", async () => {
      const recorded = stubFetch([new Response(null, { status: 200 })]);

      const result = await setOrgAutoGenerateContentAction({ slug: "acme", enabled: false });

      expect(result).toEqual({ ok: true });
      expect(recorded[0]?.method).toBe("PATCH");
      expect(recorded[0]?.url).toBe("http://api.test.local/v1/orgs/acme");
      expect(JSON.parse(recorded[0]?.body ?? "null")).toEqual({ autoGenerateContent: false });
      expect(revalidatedPaths).toEqual(["/acme", "/acme/admin"]);
    });
  });

  describe("setOrgFeaturedAction", () => {
    it("happy path: PATCH /v1/orgs/:slug with featured, revalidates / and /:slug", async () => {
      const recorded = stubFetch([new Response(null, { status: 200 })]);

      const result = await setOrgFeaturedAction({ slug: "acme", featured: true });

      expect(result).toEqual({ ok: true });
      expect(recorded[0]?.method).toBe("PATCH");
      expect(JSON.parse(recorded[0]?.body ?? "null")).toEqual({ featured: true });
      expect(revalidatedPaths).toEqual(["/", "/acme", "/acme/admin"]);
    });
  });

  describe("setOrgNoticeAction", () => {
    it("happy path: PATCH /v1/orgs/:slug with notice, revalidates only /:slug", async () => {
      const notice = {
        message: "Under new ownership",
        linkText: "Read more",
        href: "https://example.com",
      };
      const recorded = stubFetch([new Response(null, { status: 200 })]);

      const result = await setOrgNoticeAction({ slug: "acme", notice });

      expect(result).toEqual({ ok: true });
      expect(JSON.parse(recorded[0]?.body ?? "null")).toEqual({ notice });
      expect(revalidatedPaths).toEqual(["/acme", "/acme/admin"]);
    });

    it("clears the notice by sending null", async () => {
      const recorded = stubFetch([new Response(null, { status: 200 })]);

      const result = await setOrgNoticeAction({ slug: "acme", notice: null });

      expect(result).toEqual({ ok: true });
      expect(JSON.parse(recorded[0]?.body ?? "null")).toEqual({ notice: null });
    });
  });

  describe("renameOrgAction", () => {
    it("happy path: PATCH /v1/orgs/:slug with name, revalidates / and /:slug", async () => {
      const recorded = stubFetch([new Response(null, { status: 200 })]);

      const result = await renameOrgAction({ slug: "acme", name: "Acme Corp" });

      expect(result).toEqual({ ok: true });
      expect(JSON.parse(recorded[0]?.body ?? "null")).toEqual({ name: "Acme Corp" });
      expect(revalidatedPaths).toEqual(["/", "/acme", "/acme/admin"]);
    });
  });

  describe("setOrgFetchPausedAction", () => {
    it("happy path: PATCH /v1/orgs/:slug with fetchPaused", async () => {
      const recorded = stubFetch([new Response(null, { status: 200 })]);

      const result = await setOrgFetchPausedAction({ slug: "acme", paused: true });

      expect(result).toEqual({ ok: true });
      expect(JSON.parse(recorded[0]?.body ?? "null")).toEqual({ fetchPaused: true });
      expect(revalidatedPaths).toEqual(["/acme", "/acme/admin"]);
    });
  });

  describe("setOrgOverviewCadenceDaysAction", () => {
    it("happy path: PATCH with a day count", async () => {
      const recorded = stubFetch([new Response(null, { status: 200 })]);

      const result = await setOrgOverviewCadenceDaysAction({ slug: "acme", days: 14 });

      expect(result).toEqual({ ok: true });
      expect(JSON.parse(recorded[0]?.body ?? "null")).toEqual({ overviewCadenceDays: 14 });
      expect(revalidatedPaths).toEqual(["/acme", "/acme/admin"]);
    });

    it("happy path: clear override with null", async () => {
      const recorded = stubFetch([new Response(null, { status: 200 })]);

      const result = await setOrgOverviewCadenceDaysAction({ slug: "acme", days: null });

      expect(result).toEqual({ ok: true });
      expect(JSON.parse(recorded[0]?.body ?? "null")).toEqual({ overviewCadenceDays: null });
    });

    it("rejects out-of-range values without calling the API", async () => {
      const recorded = stubFetch([]);

      const result = await setOrgOverviewCadenceDaysAction({ slug: "acme", days: 0 });

      expect(result.ok).toBe(false);
      expect(recorded).toHaveLength(0);
    });
  });
});
