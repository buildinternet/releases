import { describe, it, expect } from "bun:test";
import {
  requestDeviceCode,
  pollForToken,
  runDeviceAuth,
  createUserApiKey,
  revokeUserApiKey,
  revokeKeyQuietly,
  signOutSession,
  revokePresentedKey,
} from "../../src/lib/device-auth.js";

const BASE = "https://test.example.com";

describe("requestDeviceCode", () => {
  it("POSTs client_id + scope (the approval purpose) and returns the code payload", async () => {
    let seen: { url: string; body: unknown } | null = null;
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seen = { url, body: JSON.parse(String(init?.body)) };
      return new Response(
        JSON.stringify({
          device_code: "dev123",
          user_code: "ABCD1234",
          verification_uri: "https://releases.sh/device",
          verification_uri_complete: "https://releases.sh/device?user_code=ABCD1234",
          expires_in: 900,
          interval: 5,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const res = await requestDeviceCode(BASE, "keys", fakeFetch);
    expect(res.user_code).toBe("ABCD1234");
    expect(seen!.url).toBe(`${BASE}/api/auth/device/code`);
    expect(seen!.body).toEqual({ client_id: "releases-cli", scope: "keys" });
  });

  it("sends the exact purpose given (login | keys | publish-tokens)", async () => {
    const seenScopes: string[] = [];
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      seenScopes.push(JSON.parse(String(init?.body)).scope);
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
    }) as unknown as typeof fetch;

    await requestDeviceCode(BASE, "login", fakeFetch);
    await requestDeviceCode(BASE, "keys", fakeFetch);
    await requestDeviceCode(BASE, "publish-tokens", fakeFetch);
    expect(seenScopes).toEqual(["login", "keys", "publish-tokens"]);
  });
});

describe("pollForToken", () => {
  it("returns the access_token after an authorization_pending round", async () => {
    let call = 0;
    const fakeFetch = (async () => {
      call += 1;
      if (call === 1) {
        return new Response(JSON.stringify({ error: "authorization_pending" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ access_token: "tok_abc" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const token = await pollForToken(BASE, "dev123", {
      intervalSeconds: 0, // no real waiting in tests
      expiresInSeconds: 60,
      fetchImpl: fakeFetch,
      sleep: async () => {},
    });
    expect(token).toBe("tok_abc");
    expect(call).toBe(2);
  });

  it("throws when the user denies", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: "access_denied" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    await expect(
      pollForToken(BASE, "dev123", {
        intervalSeconds: 0,
        expiresInSeconds: 60,
        fetchImpl: fakeFetch,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/denied/i);
  });
});

describe("runDeviceAuth", () => {
  it("prints a purpose-specific description and mints no key", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string) => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith("/device/code"))
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
      if (u.endsWith("/device/token"))
        return new Response(JSON.stringify({ access_token: "sess_tok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (u.endsWith("/get-session"))
        return new Response(JSON.stringify({ user: { email: "a@b.co", name: "A" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      throw new Error(`unexpected ${u}`);
    }) as unknown as typeof fetch;

    const printed: string[] = [];
    const res = await runDeviceAuth({
      apiUrl: "https://test.example.com",
      purpose: "keys",
      openInBrowser: false,
      deps: { fetchImpl: fakeFetch, sleep: async () => {}, print: (l) => printed.push(l) },
    });
    expect(res.sessionToken).toBe("sess_tok");
    expect(calls.some((u) => u.endsWith("/v1/api-keys"))).toBe(false);
    expect(printed.some((l) => l.includes("manage your API keys"))).toBe(true);
  });

  /**
   * Regression guard: a manual run of `releases keys list` against a local
   * stub server once launched the REAL default browser (via `openBrowser`
   * from `../lib/open-browser.js`, which shells out to `open`/`xdg-open`)
   * because no `--no-browser` flag existed on `keys`/`publish-token`. Every
   * command now threads `openInBrowser` through to here — this test pins
   * down that `openInBrowser: false` means `deps.openBrowser` is NEVER
   * invoked, even when one is supplied, so an injected stub (or the real
   * opener, in production) can't fire when the caller asked not to.
   */
  it("never calls deps.openBrowser when openInBrowser is false, even if one is supplied", async () => {
    const fakeFetch = (async (url: string) => {
      const u = String(url);
      if (u.endsWith("/device/code"))
        return new Response(
          JSON.stringify({
            device_code: "d",
            user_code: "U",
            verification_uri: "https://x/device",
            verification_uri_complete: "https://x/device?user_code=U",
            expires_in: 900,
            interval: 0,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      if (u.endsWith("/device/token"))
        return new Response(JSON.stringify({ access_token: "sess_tok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (u.endsWith("/get-session"))
        return new Response(JSON.stringify({ user: null }), { status: 200 });
      throw new Error(`unexpected ${u}`);
    }) as unknown as typeof fetch;

    let openBrowserCalled = false;
    const printed: string[] = [];
    await runDeviceAuth({
      apiUrl: "https://test.example.com",
      purpose: "keys",
      openInBrowser: false,
      deps: {
        fetchImpl: fakeFetch,
        sleep: async () => {},
        print: (l) => printed.push(l),
        openBrowser: () => {
          openBrowserCalled = true;
          return true;
        },
      },
    });

    expect(openBrowserCalled).toBe(false);
    expect(printed.some((l) => l.includes("Opening your browser"))).toBe(false);
  });
});

describe("createUserApiKey", () => {
  it("returns the created key's id alongside the secret", async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          key: "relu_secret",
          id: "ak_1",
          name: "releases-cli (host)",
          scope: "read",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    const created = await createUserApiKey(BASE, "sess_tok", "releases-cli (host)", fakeFetch);
    expect(created.key).toBe("relu_secret");
    expect(created.id).toBe("ak_1");
  });

  it("throws a plain Error on a generic failure", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: { code: "internal_error" } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    await expect(createUserApiKey(BASE, "sess_tok", "name", fakeFetch)).rejects.toThrow(/HTTP 500/);
  });

  it("turns the 409 key-limit response into a message with the way out", async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "api_key_limit",
            message: "API key limit reached (max 25 active keys). Revoke one and try again.",
          },
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    const err = (await createUserApiKey(BASE, "sess_tok", "name", fakeFetch).catch(
      (e) => e,
    )) as Error;
    expect(err.message).toMatch(/limit reached/i);
    expect(err.message).toContain("releases keys revoke <id>");
  });

  it("keeps the plain message on a 409 that isn't the key-limit code (e.g. idempotency conflict)", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: { code: "idempotency_conflict" } }), {
        status: 409,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const err = (await createUserApiKey(BASE, "sess_tok", "name", fakeFetch).catch(
      (e) => e,
    )) as Error;
    expect(err.message).toMatch(/HTTP 409/);
    expect(err.message).not.toContain("releases keys revoke");
  });
});

describe("revokeUserApiKey", () => {
  it("DELETEs the key by id with the session token as Bearer", async () => {
    let seen: { url: string; method?: string; auth: string } | null = null;
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seen = {
        url: String(url),
        method: init?.method,
        auth: String((init?.headers as Record<string, string>)?.authorization ?? ""),
      };
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    await revokeUserApiKey(BASE, "sess_tok", "ak_1", fakeFetch);
    expect(seen!.url).toBe(`${BASE}/v1/api-keys/ak_1`);
    expect(seen!.method).toBe("DELETE");
    expect(seen!.auth).toBe("Bearer sess_tok");
  });

  it("throws on a non-ok response", async () => {
    const fakeFetch = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    await expect(revokeUserApiKey(BASE, "sess_tok", "ak_1", fakeFetch)).rejects.toThrow(/HTTP 404/);
  });
});

describe("revokeKeyQuietly", () => {
  it("returns null on success and the failure message instead of throwing", async () => {
    const ok = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const bad = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    expect(await revokeKeyQuietly(BASE, "sess_tok", "ak_1", ok)).toBeNull();
    expect(await revokeKeyQuietly(BASE, "sess_tok", "ak_1", bad)).toMatch(/HTTP 404/);
  });
});

describe("signOutSession", () => {
  it("POSTs to /api/auth/sign-out with the session token as Bearer and an empty body", async () => {
    let seen: { url: string; method?: string; auth: string; body: string } | null = null;
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seen = {
        url: String(url),
        method: init?.method,
        auth: String((init?.headers as Record<string, string>)?.authorization ?? ""),
        body: String(init?.body ?? ""),
      };
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const result = await signOutSession(BASE, "sess_tok", fakeFetch);
    expect(result).toBeNull();
    expect(seen!.url).toBe(`${BASE}/api/auth/sign-out`);
    expect(seen!.method).toBe("POST");
    expect(seen!.auth).toBe("Bearer sess_tok");
    expect(JSON.parse(seen!.body)).toEqual({});
  });

  it("never throws: returns a message on a non-ok response or a network error", async () => {
    const bad = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    expect(await signOutSession(BASE, "sess_tok", bad)).toMatch(/HTTP 500/);

    const throws = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await signOutSession(BASE, "sess_tok", throws)).toMatch(/network down/);
  });
});

describe("revokePresentedKey", () => {
  it("DELETEs /v1/tokens/me with the key as Bearer", async () => {
    let seen: { url: string; method?: string; auth: string } | null = null;
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seen = {
        url: String(url),
        method: init?.method,
        auth: String((init?.headers as Record<string, string>)?.authorization ?? ""),
      };
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await revokePresentedKey(BASE, "relu_abc", fakeFetch);
    expect(result).toEqual({ ok: true, alreadyRevoked: false });
    expect(seen!.url).toBe(`${BASE}/v1/tokens/me`);
    expect(seen!.method).toBe("DELETE");
    expect(seen!.auth).toBe("Bearer relu_abc");
  });

  it("treats a 401 as already-gone, not a failure", async () => {
    const fakeFetch = (async () => new Response(null, { status: 401 })) as unknown as typeof fetch;
    expect(await revokePresentedKey(BASE, "relu_abc", fakeFetch)).toEqual({
      ok: true,
      alreadyRevoked: true,
    });
  });

  it("returns an error result on other failures, never throwing", async () => {
    const bad = (async () => new Response(null, { status: 400 })) as unknown as typeof fetch;
    const result = await revokePresentedKey(BASE, "relu_abc", bad);
    expect(result.ok).toBe(false);
  });
});
