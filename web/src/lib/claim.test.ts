import { describe, it, expect, afterEach, beforeEach } from "bun:test";

const ORIG = process.env.NEXT_PUBLIC_BETTER_AUTH_URL;
process.env.NEXT_PUBLIC_BETTER_AUTH_URL = "https://api.test";

const { startClaim, verifyClaim, listClaims, promoteListing } = await import("./claim.js");

type Call = { url: string; init?: RequestInit };
let calls: Call[] = [];
function mockFetch(response: unknown, ok = true, status = 200) {
  calls = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok,
      status,
      json: async () => response,
    } as Response;
  }) as typeof fetch;
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_BETTER_AUTH_URL = "https://api.test";
});

afterEach(() => {
  if (ORIG === undefined) delete process.env.NEXT_PUBLIC_BETTER_AUTH_URL;
  else process.env.NEXT_PUBLIC_BETTER_AUTH_URL = ORIG;
});

describe("claim client", () => {
  it("starts a claim via POST with credentials", async () => {
    mockFetch(
      {
        id: "clm_1",
        org: { slug: "acme", name: "Acme", webUrl: "https://releases.sh/acme" },
        status: "pending",
        token: "relv_abc",
        createdAt: "2026-07-07T00:00:00.000Z",
        expiresAt: "2026-07-14T00:00:00.000Z",
        instructions: {
          wellKnownUrl: "https://acme.com/.well-known/releases-verify.txt",
          dnsRecordName: "_releases-challenge.acme.com",
        },
      },
      true,
      201,
    );
    const claim = await startClaim("acme.com");
    expect(claim.id).toBe("clm_1");
    expect(calls[0]!.url).toBe("https://api.test/v1/listing/claim");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.credentials).toBe("include");
    expect(calls[0]!.init?.body).toBe(JSON.stringify({ domain: "acme.com" }));
  });

  it("decodes the nested error envelope on a failed start", async () => {
    mockFetch(
      { error: { code: "not_found", type: "NotFoundError", message: "activate a listing first" } },
      false,
      404,
    );
    await expect(startClaim("nope.com")).rejects.toThrow(/activate a listing first/);
  });

  it("falls back to a generic message when the body can't be decoded", async () => {
    calls = [];
    globalThis.fetch = (async () => {
      return {
        ok: false,
        status: 500,
        json: async () => {
          throw new Error("not json");
        },
      } as unknown as Response;
    }) as typeof fetch;
    await expect(startClaim("acme.com")).rejects.toThrow(/Could not start a claim/);
  });

  it("returns a friendly message on 429 without decoding the body", async () => {
    mockFetch({ error: { message: "ignored" } }, false, 429);
    await expect(startClaim("acme.com")).rejects.toThrow(/Too many attempts/);
  });

  it("wraps a transport failure (offline/DNS) in a friendly message", async () => {
    calls = [];
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    await expect(startClaim("acme.com")).rejects.toThrow(/Could not reach the server/);
  });

  it("verifyClaim passes through a verified:false result with mismatch/unreachable checks", async () => {
    mockFetch({
      verified: false,
      checked: { wellKnown: "mismatch", dnsTxt: "unreachable" },
      claim: {
        id: "clm_1",
        org: { slug: "acme", name: "Acme", webUrl: "https://releases.sh/acme" },
        status: "pending",
        method: null,
        createdAt: "2026-07-07T00:00:00.000Z",
        expiresAt: "2026-07-14T00:00:00.000Z",
      },
    });
    const result = await verifyClaim("clm_1");
    expect(result.verified).toBe(false);
    expect(result.checked).toEqual({ wellKnown: "mismatch", dnsTxt: "unreachable" });
    expect(result.claim.status).toBe("pending");
    expect(result.claim).not.toHaveProperty("token");
    expect(result.claim).not.toHaveProperty("instructions");
  });

  it("verifies a claim via POST with the claim id", async () => {
    mockFetch({
      verified: true,
      checked: { wellKnown: "ok", dnsTxt: "mismatch" },
      claim: {
        id: "clm_1",
        org: { slug: "acme", name: "Acme", webUrl: "https://releases.sh/acme" },
        status: "verified",
        method: "well-known",
        createdAt: "2026-07-07T00:00:00.000Z",
        verifiedAt: "2026-07-07T00:05:00.000Z",
        expiresAt: "2026-07-14T00:00:00.000Z",
      },
    });
    const result = await verifyClaim("clm_1");
    expect(result.verified).toBe(true);
    expect(calls[0]!.url).toBe("https://api.test/v1/listing/claim/verify");
    expect(calls[0]!.init?.body).toBe(JSON.stringify({ claimId: "clm_1" }));
  });

  it("lists the caller's claims", async () => {
    mockFetch({ claims: [] });
    const claims = await listClaims();
    expect(claims).toEqual([]);
    expect(calls[0]!.url).toBe("https://api.test/v1/listing/claims");
    expect(calls[0]!.init?.credentials).toBe("include");
  });

  it("promotes a listing via POST with the domain", async () => {
    mockFetch({
      promoted: true,
      sources: { created: 1, matched: 0 },
      locators: [{ locator: "https://acme.com/feed.xml", outcome: "live" }],
    });
    const result = await promoteListing("acme.com");
    expect(result.promoted).toBe(true);
    expect(calls[0]!.url).toBe("https://api.test/v1/listing/promote");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.credentials).toBe("include");
    expect(calls[0]!.init?.body).toBe(JSON.stringify({ domain: "acme.com" }));
  });

  it("decodes the 403 envelope when no verified claim exists", async () => {
    mockFetch(
      {
        error: {
          code: "forbidden",
          type: "forbidden",
          message: "verified ownership claim is required",
        },
      },
      false,
      403,
    );
    await expect(promoteListing("acme.com")).rejects.toThrow(/verified ownership claim/);
  });

  it("decodes the 409 envelope on promotion contention", async () => {
    mockFetch(
      { error: { code: "conflict", type: "conflict", message: "Promotion already in progress" } },
      false,
      409,
    );
    await expect(promoteListing("acme.com")).rejects.toThrow(/already in progress/);
  });

  it("falls back to a generic message when promote fails without a decodable body", async () => {
    calls = [];
    globalThis.fetch = (async () => {
      return {
        ok: false,
        status: 404,
        json: async () => {
          throw new Error("not json");
        },
      } as unknown as Response;
    }) as typeof fetch;
    await expect(promoteListing("acme.com")).rejects.toThrow(/Could not enable tracking/);
  });

  it("wraps a transport failure on promote in the same friendly message", async () => {
    calls = [];
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    await expect(promoteListing("acme.com")).rejects.toThrow(/Could not reach the server/);
  });
});
