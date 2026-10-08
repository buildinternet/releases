import { describe, it, expect } from "bun:test";
import { runLoginFlow } from "../../src/cli/commands/login.js";
import type { StoredCredential } from "../../src/lib/credentials.js";

const BASE = "https://test.example.com";

/**
 * A fake `fetch` that answers the RFC 8628 device-flow sequence
 * (device/code → device/token → get-session) deterministically, then hands
 * off any `/v1/api-keys*` call to `apiKeys`, recording every request's
 * method + URL in `calls` in the order they happen.
 */
function makeFakeFetch(
  apiKeys: (url: string, init: RequestInit | undefined) => Response,
  calls: { method: string; url: string }[] = [],
) {
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    calls.push({ method: init?.method ?? "GET", url: u });
    if (u.endsWith("/device/code")) {
      return new Response(
        JSON.stringify({
          device_code: "d",
          user_code: "U",
          verification_uri: "https://x/device",
          expires_in: 900,
          interval: 0,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (u.endsWith("/device/token")) {
      return new Response(JSON.stringify({ access_token: "sess_tok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.endsWith("/get-session")) {
      return new Response(JSON.stringify({ user: { email: "a@example.com" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.endsWith("/api/auth/sign-out")) {
      // Not tracked in the `order`/`calls` assertions below — the sign-out
      // happening (and happening last) is asserted separately via `calls`.
      return new Response(null, { status: 200 });
    }
    if (u.includes("/v1/api-keys")) {
      return apiKeys(u, init);
    }
    throw new Error(`unexpected url ${u}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("runLoginFlow", () => {
  it("persists the new key's id on a first-time login (no previous credential)", async () => {
    const { fetchImpl } = makeFakeFetch((url, init) => {
      if (init?.method === "POST") {
        return jsonResponse({ key: "relu_new", id: "ak_new", name: "n", scope: "read" }, 201);
      }
      throw new Error(`unexpected api-keys call ${url}`);
    });

    let written: StoredCredential | null = null;
    const cred = await runLoginFlow({
      apiUrl: BASE,
      openInBrowser: false,
      keyName: "releases-cli (host)",
      deps: {
        fetchImpl,
        sleep: async () => {},
        print: () => {},
        readCredential: () => null,
        writeCredential: (c) => {
          written = c;
        },
      },
    });

    expect(cred.keyId).toBe("ak_new");
    expect(cred.token).toBe("relu_new");
    expect(written).not.toBeNull();
    expect(written!.keyId).toBe("ak_new");
  });

  it("revokes the previous key for the same apiUrl only after the new one is minted and stored", async () => {
    const order: string[] = [];
    const { fetchImpl, calls } = makeFakeFetch((url, init) => {
      if (init?.method === "DELETE") {
        order.push("delete");
        return new Response(null, { status: 204 });
      }
      order.push("create");
      return jsonResponse({ key: "relu_new", id: "ak_new", name: "n", scope: "read" }, 201);
    });

    const previous: StoredCredential = {
      token: "relu_old",
      keyId: "ak_old",
      apiUrl: BASE,
      savedAt: "2026-01-01T00:00:00.000Z",
    };

    let written: StoredCredential | null = null;
    await runLoginFlow({
      apiUrl: BASE,
      openInBrowser: false,
      keyName: "releases-cli (host)",
      deps: {
        fetchImpl,
        sleep: async () => {},
        print: () => {},
        readCredential: () => previous,
        writeCredential: (c) => {
          order.push("write");
          written = c;
        },
      },
    });

    // Mint, then persist, then revoke — never the other way around, so a
    // crash between mint and persist never leaves the user keyless.
    expect(order).toEqual(["create", "write", "delete"]);
    expect(written).not.toBeNull();
    expect(written!.keyId).toBe("ak_new");
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/v1/api-keys/ak_old"))).toBe(
      true,
    );
  });

  it("never revokes anything when the mint itself fails", async () => {
    const { fetchImpl, calls } = makeFakeFetch((_url, init) => {
      if (init?.method === "DELETE") throw new Error("should not be called");
      return jsonResponse({ error: { code: "internal_error" } }, 500);
    });

    const previous: StoredCredential = {
      token: "relu_old",
      keyId: "ak_old",
      apiUrl: BASE,
      savedAt: "2026-01-01T00:00:00.000Z",
    };

    await expect(
      runLoginFlow({
        apiUrl: BASE,
        openInBrowser: false,
        keyName: "releases-cli (host)",
        deps: {
          fetchImpl,
          sleep: async () => {},
          print: () => {},
          readCredential: () => previous,
          writeCredential: () => {
            throw new Error("writeCredential should not be reached");
          },
        },
      }),
    ).rejects.toThrow(/HTTP 500/);

    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("skips revocation silently for a legacy credential with no keyId", async () => {
    const { fetchImpl, calls } = makeFakeFetch((_url, init) => {
      if (init?.method === "DELETE") throw new Error("should not be called");
      return jsonResponse({ key: "relu_new", id: "ak_new", name: "n", scope: "read" }, 201);
    });

    // Legacy credential, predates #418 — no keyId to revoke by, and we must
    // never guess one from `start`.
    const previous: StoredCredential = {
      token: "relu_old",
      apiUrl: BASE,
      savedAt: "2026-01-01T00:00:00.000Z",
    };

    const printed: string[] = [];
    await runLoginFlow({
      apiUrl: BASE,
      openInBrowser: false,
      keyName: "releases-cli (host)",
      deps: {
        fetchImpl,
        sleep: async () => {},
        print: (l) => printed.push(l),
        readCredential: () => previous,
        writeCredential: () => {},
      },
    });

    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(printed.some((l) => l.includes("Could not revoke"))).toBe(false);
  });

  it("does not revoke a previous credential from a different apiUrl", async () => {
    const { fetchImpl, calls } = makeFakeFetch((_url, init) => {
      if (init?.method === "DELETE") throw new Error("should not be called");
      return jsonResponse({ key: "relu_new", id: "ak_new", name: "n", scope: "read" }, 201);
    });

    const previous: StoredCredential = {
      token: "relu_old",
      keyId: "ak_old",
      apiUrl: "https://staging.example.com",
      savedAt: "2026-01-01T00:00:00.000Z",
    };

    await runLoginFlow({
      apiUrl: BASE,
      openInBrowser: false,
      keyName: "releases-cli (host)",
      deps: {
        fetchImpl,
        sleep: async () => {},
        print: () => {},
        readCredential: () => previous,
        writeCredential: () => {},
      },
    });

    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("treats revocation failure as non-fatal: login still succeeds with a printed warning", async () => {
    const { fetchImpl } = makeFakeFetch((_url, init) => {
      if (init?.method === "DELETE") {
        return jsonResponse({ error: { code: "internal_error" } }, 500);
      }
      return jsonResponse({ key: "relu_new", id: "ak_new", name: "n", scope: "read" }, 201);
    });

    const previous: StoredCredential = {
      token: "relu_old",
      keyId: "ak_old",
      apiUrl: BASE,
      savedAt: "2026-01-01T00:00:00.000Z",
    };

    const printed: string[] = [];
    let written: StoredCredential | null = null;
    const cred = await runLoginFlow({
      apiUrl: BASE,
      openInBrowser: false,
      keyName: "releases-cli (host)",
      deps: {
        fetchImpl,
        sleep: async () => {},
        print: (l) => printed.push(l),
        readCredential: () => previous,
        writeCredential: (c) => {
          written = c;
        },
      },
    });

    // The login itself succeeded (new credential minted and stored) despite
    // the revoke failing.
    expect(cred.keyId).toBe("ak_new");
    expect(written).not.toBeNull();
    expect(printed.some((l) => l.includes("Could not revoke the previous key"))).toBe(true);
  });

  it("on the 409 active-key-limit response, fails with the way out and writes nothing", async () => {
    const { fetchImpl, calls } = makeFakeFetch(() =>
      jsonResponse(
        {
          error: {
            code: "api_key_limit",
            message: "API key limit reached (max 25 active keys). Revoke one and try again.",
          },
        },
        409,
      ),
    );

    await expect(
      runLoginFlow({
        apiUrl: BASE,
        openInBrowser: false,
        keyName: "releases-cli (host)",
        deps: {
          fetchImpl,
          sleep: async () => {},
          print: () => {},
          readCredential: () => null,
          writeCredential: () => {
            throw new Error("writeCredential should not be reached");
          },
        },
      }),
    ).rejects.toThrow(/limit reached.*releases keys list.*releases keys revoke <id>/is);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("never persists a session token on the stored credential", async () => {
    const { fetchImpl } = makeFakeFetch(() =>
      jsonResponse({ key: "relu_new", id: "ak_new", name: "n", scope: "read" }, 201),
    );
    let written: StoredCredential | null = null;
    const cred = await runLoginFlow({
      apiUrl: BASE,
      openInBrowser: false,
      keyName: "releases-cli (host)",
      deps: {
        fetchImpl,
        sleep: async () => {},
        print: () => {},
        readCredential: () => null,
        writeCredential: (c) => {
          written = c;
        },
      },
    });
    expect(cred).not.toHaveProperty("sessionToken");
    expect(written).not.toHaveProperty("sessionToken");
  });

  it("signs the session out as the last network call, after mint/write/revoke", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith("/device/code")) {
        return jsonResponse({
          device_code: "d",
          user_code: "U",
          verification_uri: "https://x/device",
          expires_in: 900,
          interval: 0,
        });
      }
      if (u.endsWith("/device/token")) return jsonResponse({ access_token: "sess_tok" });
      if (u.endsWith("/get-session")) return jsonResponse({ user: { email: "a@example.com" } });
      if (u.endsWith("/api/auth/sign-out")) return new Response(null, { status: 200 });
      if (u.includes("/v1/api-keys")) {
        if (init?.method === "DELETE") return new Response(null, { status: 204 });
        return jsonResponse({ key: "relu_new", id: "ak_new", name: "n", scope: "read" }, 201);
      }
      throw new Error(`unexpected url ${u}`);
    }) as unknown as typeof fetch;

    const previous: StoredCredential = {
      token: "relu_old",
      keyId: "ak_old",
      apiUrl: BASE,
      savedAt: "2026-01-01T00:00:00.000Z",
    };

    await runLoginFlow({
      apiUrl: BASE,
      openInBrowser: false,
      keyName: "releases-cli (host)",
      deps: {
        fetchImpl,
        sleep: async () => {},
        print: () => {},
        readCredential: () => previous,
        writeCredential: () => {},
      },
    });

    expect(calls.at(-1)).toBe(`${BASE}/api/auth/sign-out`);
  });

  it("retires a legacy stored session token before starting the new login", async () => {
    const { fetchImpl } = makeFakeFetch(() =>
      jsonResponse({ key: "relu_new", id: "ak_new", name: "n", scope: "read" }, 201),
    );

    const previous: StoredCredential = {
      token: "relu_old",
      sessionToken: "legacy_sess",
      keyId: "ak_old",
      apiUrl: BASE,
      savedAt: "2026-01-01T00:00:00.000Z",
    };

    let retiredWith: string | null = null;
    await runLoginFlow({
      apiUrl: BASE,
      openInBrowser: false,
      keyName: "releases-cli (host)",
      deps: {
        fetchImpl: (async (url: string, init?: RequestInit) => {
          if (String(url).endsWith("/api/auth/sign-out")) {
            const auth = String((init?.headers as Record<string, string>)?.authorization ?? "");
            if (auth === "Bearer legacy_sess") retiredWith = auth;
          }
          return fetchImpl(url as unknown as URL, init);
        }) as unknown as typeof fetch,
        sleep: async () => {},
        print: () => {},
        readCredential: () => previous,
        writeCredential: () => {},
      },
    });

    expect(retiredWith).toBe("Bearer legacy_sess");
  });

  it("signs the session out even when minting fails", async () => {
    const { fetchImpl, calls } = makeFakeFetch(() =>
      jsonResponse({ error: { code: "internal_error" } }, 500),
    );
    await expect(
      runLoginFlow({
        apiUrl: BASE,
        openInBrowser: false,
        keyName: "releases-cli (host)",
        deps: {
          fetchImpl,
          sleep: async () => {},
          print: () => {},
          readCredential: () => null,
          writeCredential: () => {},
        },
      }),
    ).rejects.toThrow(/HTTP 500/);
    expect(calls.at(-1)?.url).toBe(`${BASE}/api/auth/sign-out`);
  });

  it("signs the session out even when storing the key fails", async () => {
    const { fetchImpl, calls } = makeFakeFetch(() =>
      jsonResponse({ key: "relu_new", id: "ak_new", name: "n", scope: "read" }, 201),
    );
    await expect(
      runLoginFlow({
        apiUrl: BASE,
        openInBrowser: false,
        keyName: "releases-cli (host)",
        deps: {
          fetchImpl,
          sleep: async () => {},
          print: () => {},
          readCredential: () => null,
          writeCredential: () => {
            throw new Error("disk full");
          },
        },
      }),
    ).rejects.toThrow(/disk full/);
    expect(calls.at(-1)?.url).toBe(`${BASE}/api/auth/sign-out`);
  });

  it("still succeeds, with a note, when the sign-out itself fails", async () => {
    const { fetchImpl: inner } = makeFakeFetch(() =>
      jsonResponse({ key: "relu_new", id: "ak_new", name: "n", scope: "read" }, 201),
    );
    const fetchImpl = (async (url: string, init?: RequestInit) =>
      String(url).endsWith("/api/auth/sign-out")
        ? new Response(null, { status: 500 })
        : inner(url, init)) as unknown as typeof fetch;
    const printed: string[] = [];
    const cred = await runLoginFlow({
      apiUrl: BASE,
      openInBrowser: false,
      keyName: "releases-cli (host)",
      deps: {
        fetchImpl,
        sleep: async () => {},
        print: (l) => printed.push(l),
        readCredential: () => null,
        writeCredential: () => {},
      },
    });
    expect(cred.token).toBe("relu_new");
    expect(printed.some((l) => l.includes("Could not sign out"))).toBe(true);
  });
});
