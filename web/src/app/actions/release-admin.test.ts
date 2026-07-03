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
let suppressReleaseAction: (typeof import("./release-admin"))["suppressReleaseAction"];
let deleteReleaseAction: (typeof import("./release-admin"))["deleteReleaseAction"];

describe("release-admin actions", () => {
  beforeAll(async () => {
    ({ suppressReleaseAction, deleteReleaseAction } = await import("./release-admin"));
  });

  beforeEach(() => {
    enableLocalAdminEnv();
    revalidatedPaths.length = 0;
  });

  afterEach(() => {
    restoreFetch();
  });

  describe("suppressReleaseAction", () => {
    it("happy path: POST /v1/releases/:id/suppress with a trimmed reason, revalidates the release path", async () => {
      const recorded = stubFetch([new Response(null, { status: 200 })]);

      const result = await suppressReleaseAction({ id: "rel_123", reason: "  duplicate  " });

      expect(result).toEqual({ ok: true, redirectTo: undefined });
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.method).toBe("POST");
      expect(recorded[0]?.url).toBe("http://api.test.local/v1/releases/rel_123/suppress");
      expect(recorded[0]?.headers.authorization).toBe("Bearer test-admin-key");
      expect(JSON.parse(recorded[0]?.body ?? "null")).toEqual({ reason: "duplicate" });
      expect(revalidatedPaths).toEqual(["/release/rel_123"]);
    });

    it("sends an empty body when reason is blank/omitted", async () => {
      const recorded = stubFetch([new Response(null, { status: 200 })]);

      await suppressReleaseAction({ id: "rel_123", reason: "   " });

      expect(JSON.parse(recorded[0]?.body ?? "null")).toEqual({});
    });

    it("also revalidates redirectTo when provided", async () => {
      stubFetch([new Response(null, { status: 200 })]);

      const result = await suppressReleaseAction({
        id: "rel_123",
        redirectTo: "/acme",
      });

      expect(result).toEqual({ ok: true, redirectTo: "/acme" });
      expect(revalidatedPaths).toEqual(["/release/rel_123", "/acme"]);
    });

    it("API error: maps a non-ok response to ok:false without revalidating", async () => {
      stubFetch([new Response("Forbidden", { status: 403, statusText: "Forbidden" })]);

      const result = await suppressReleaseAction({ id: "rel_123" });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("403");
      expect(revalidatedPaths).toEqual([]);
    });

    it("network error: fetch rejection maps to ok:false without revalidating", async () => {
      stubFetchReject(new Error("network down"));

      const result = await suppressReleaseAction({ id: "rel_123" });

      expect(result).toEqual({ ok: false, error: "network down" });
      expect(revalidatedPaths).toEqual([]);
    });

    it("gate closed: no admin credential (characterizes current behavior)", async () => {
      disableLocalAdminEnv();
      const recorded = stubFetch([]);

      await expect(suppressReleaseAction({ id: "rel_123" })).rejects.toThrow(
        "`cookies` was called outside a request scope",
      );
      expect(recorded).toHaveLength(0);

      enableLocalAdminEnv();
    });
  });

  describe("deleteReleaseAction", () => {
    it("happy path: DELETE /v1/releases/:id, revalidates the release path", async () => {
      const recorded = stubFetch([new Response(null, { status: 200 })]);

      const result = await deleteReleaseAction({ id: "rel_456" });

      expect(result).toEqual({ ok: true, redirectTo: undefined });
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.method).toBe("DELETE");
      expect(recorded[0]?.url).toBe("http://api.test.local/v1/releases/rel_456");
      expect(recorded[0]?.headers.authorization).toBe("Bearer test-admin-key");
      expect(recorded[0]?.body).toBeNull();
      expect(revalidatedPaths).toEqual(["/release/rel_456"]);
    });

    it("also revalidates redirectTo when provided", async () => {
      stubFetch([new Response(null, { status: 200 })]);

      const result = await deleteReleaseAction({ id: "rel_456", redirectTo: "/acme" });

      expect(result).toEqual({ ok: true, redirectTo: "/acme" });
      expect(revalidatedPaths).toEqual(["/release/rel_456", "/acme"]);
    });

    it("API error: maps a non-ok response to ok:false without revalidating", async () => {
      stubFetch([new Response("Not found", { status: 404, statusText: "Not Found" })]);

      const result = await deleteReleaseAction({ id: "rel_456" });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("404");
      expect(revalidatedPaths).toEqual([]);
    });

    it("network error: fetch rejection maps to ok:false without revalidating", async () => {
      stubFetchReject(new Error("network down"));

      const result = await deleteReleaseAction({ id: "rel_456" });

      expect(result).toEqual({ ok: false, error: "network down" });
      expect(revalidatedPaths).toEqual([]);
    });
  });
});
