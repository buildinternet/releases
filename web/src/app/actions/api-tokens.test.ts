import { describe, it, expect, beforeEach, afterEach, beforeAll } from "bun:test";
import {
  enableLocalAdminEnv,
  disableLocalAdminEnv,
  stubFetch,
  stubFetchReject,
  restoreFetch,
} from "./test-helpers";
import type { PublicTokenRow } from "./api-tokens";

// Loaded dynamically in beforeAll — see test-helpers.ts for why a static
// import of an action module here would race the server-only mock.
let listMyTokensAction: (typeof import("./api-tokens"))["listMyTokensAction"];
let mintTokenAction: (typeof import("./api-tokens"))["mintTokenAction"];
let revokeTokenAction: (typeof import("./api-tokens"))["revokeTokenAction"];

const PRIMARY_OWNER_TOKEN: PublicTokenRow = {
  id: "tok_1",
  lookupId: "lk_1",
  name: "CI token",
  scopes: ["read"],
  principalType: "user",
  principalId: "usr_web_admin",
  active: true,
  revokedAt: null,
  expiresAt: null,
  lastUsedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  createdBy: null,
};

const OTHER_OWNER_TOKEN: PublicTokenRow = {
  ...PRIMARY_OWNER_TOKEN,
  id: "tok_2",
  lookupId: "lk_2",
  principalId: "usr_someone_else",
};

describe("api-tokens actions", () => {
  beforeAll(async () => {
    ({ listMyTokensAction, mintTokenAction, revokeTokenAction } = await import("./api-tokens"));
  });

  beforeEach(() => {
    enableLocalAdminEnv();
  });

  afterEach(() => {
    restoreFetch();
  });

  describe("listMyTokensAction", () => {
    it("happy path: GET /v1/tokens with the admin bearer, filters to the primary owner", async () => {
      const recorded = stubFetch([
        new Response(JSON.stringify({ tokens: [PRIMARY_OWNER_TOKEN, OTHER_OWNER_TOKEN] }), {
          status: 200,
        }),
      ]);

      const result = await listMyTokensAction();

      expect(result).toEqual({ ok: true, tokens: [PRIMARY_OWNER_TOKEN] });
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.method).toBe("GET");
      expect(recorded[0]?.url).toBe("http://api.test.local/v1/tokens");
      expect(recorded[0]?.headers.authorization).toBe("Bearer test-admin-key");
    });

    it("API error: maps a non-ok response to ok:false", async () => {
      stubFetch([new Response("Forbidden", { status: 403, statusText: "Forbidden" })]);

      const result = await listMyTokensAction();

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("403");
    });

    it("network error: fetch rejection maps to ok:false", async () => {
      stubFetchReject(new Error("network down"));

      const result = await listMyTokensAction();

      expect(result).toEqual({ ok: false, error: "network down" });
    });

    it("gate closed: no admin credential (characterizes current behavior)", async () => {
      disableLocalAdminEnv();
      const recorded = stubFetch([]);

      await expect(listMyTokensAction()).rejects.toThrow(
        "`cookies` was called outside a request scope",
      );
      expect(recorded).toHaveLength(0);

      enableLocalAdminEnv();
    });
  });

  describe("mintTokenAction", () => {
    it("happy path: POST /v1/tokens with name/scopes/principal for the primary owner", async () => {
      const minted = { ...PRIMARY_OWNER_TOKEN, token: "relu_secret" };
      const recorded = stubFetch([new Response(JSON.stringify(minted), { status: 200 })]);

      const result = await mintTokenAction({ name: "  CI token  ", scopes: ["read", "bogus"] });

      expect(result).toEqual({ ok: true, token: minted });
      expect(recorded[0]?.method).toBe("POST");
      expect(recorded[0]?.url).toBe("http://api.test.local/v1/tokens");
      expect(JSON.parse(recorded[0]?.body ?? "null")).toEqual({
        name: "CI token",
        scopes: ["read"],
        principalType: "user",
        principalId: "usr_web_admin",
      });
    });

    it("includes expiresAt when provided", async () => {
      const minted = { ...PRIMARY_OWNER_TOKEN, token: "relu_secret" };
      const recorded = stubFetch([new Response(JSON.stringify(minted), { status: 200 })]);

      await mintTokenAction({
        name: "CI token",
        scopes: ["read"],
        expiresAt: "2027-01-01T00:00:00.000Z",
      });

      expect(JSON.parse(recorded[0]?.body ?? "null")).toMatchObject({
        expiresAt: "2027-01-01T00:00:00.000Z",
      });
    });

    it("rejects a blank name without calling fetch", async () => {
      const recorded = stubFetch([]);

      const result = await mintTokenAction({ name: "   ", scopes: ["read"] });

      expect(result).toEqual({ ok: false, error: "Token name is required." });
      expect(recorded).toHaveLength(0);
    });

    it("rejects when no valid scope is provided without calling fetch", async () => {
      const recorded = stubFetch([]);

      const result = await mintTokenAction({ name: "CI token", scopes: ["bogus"] });

      expect(result).toEqual({
        ok: false,
        error: "At least one scope (read, write, or admin) is required.",
      });
      expect(recorded).toHaveLength(0);
    });

    it("API error: maps a non-ok response to ok:false", async () => {
      stubFetch([new Response("Forbidden", { status: 403, statusText: "Forbidden" })]);

      const result = await mintTokenAction({ name: "CI token", scopes: ["read"] });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("403");
    });

    it("network error: fetch rejection maps to ok:false", async () => {
      stubFetchReject(new Error("network down"));

      const result = await mintTokenAction({ name: "CI token", scopes: ["read"] });

      expect(result).toEqual({ ok: false, error: "network down" });
    });
  });

  describe("revokeTokenAction", () => {
    it("happy path: looks up the token, confirms primary ownership, then POSTs revoke", async () => {
      const revoked = {
        ...PRIMARY_OWNER_TOKEN,
        active: false,
        revokedAt: "2026-07-03T00:00:00.000Z",
      };
      const recorded = stubFetch([
        new Response(JSON.stringify(PRIMARY_OWNER_TOKEN), { status: 200 }),
        new Response(JSON.stringify(revoked), { status: 200 }),
      ]);

      const result = await revokeTokenAction("tok_1");

      expect(result).toEqual({ ok: true, token: revoked });
      expect(recorded).toHaveLength(2);
      expect(recorded[0]?.method).toBe("GET");
      expect(recorded[0]?.url).toBe("http://api.test.local/v1/tokens/tok_1");
      expect(recorded[1]?.method).toBe("POST");
      expect(recorded[1]?.url).toBe("http://api.test.local/v1/tokens/tok_1/revoke");
      // Both calls reuse the single resolved credential.
      expect(recorded[0]?.headers.authorization).toBe("Bearer test-admin-key");
      expect(recorded[1]?.headers.authorization).toBe("Bearer test-admin-key");
    });

    it("refuses to revoke a token that does not belong to the primary owner", async () => {
      const recorded = stubFetch([
        new Response(JSON.stringify(OTHER_OWNER_TOKEN), { status: 200 }),
      ]);

      const result = await revokeTokenAction("tok_2");

      expect(result).toEqual({ ok: false, error: "This token is not managed by this page." });
      // Only the lookup call happens — no revoke request is sent.
      expect(recorded).toHaveLength(1);
    });

    it("rejects an empty id without calling fetch", async () => {
      const recorded = stubFetch([]);

      const result = await revokeTokenAction("");

      expect(result).toEqual({ ok: false, error: "Token ID is required." });
      expect(recorded).toHaveLength(0);
    });

    it("API error on lookup: maps a non-ok response to ok:false", async () => {
      stubFetch([new Response("Not found", { status: 404, statusText: "Not Found" })]);

      const result = await revokeTokenAction("tok_1");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("404");
    });

    it("network error: fetch rejection maps to ok:false", async () => {
      stubFetchReject(new Error("network down"));

      const result = await revokeTokenAction("tok_1");

      expect(result).toEqual({ ok: false, error: "network down" });
    });
  });
});
