import { describe, it, expect, afterEach, beforeEach } from "bun:test";

const ORIG = process.env.NEXT_PUBLIC_BETTER_AUTH_URL;

beforeEach(() => {
  process.env.NEXT_PUBLIC_BETTER_AUTH_URL = "https://api.test/v1/";
});

afterEach(() => {
  if (ORIG === undefined) delete process.env.NEXT_PUBLIC_BETTER_AUTH_URL;
  else process.env.NEXT_PUBLIC_BETTER_AUTH_URL = ORIG;
});

describe("apiBase", () => {
  it("strips trailing slashes and a mistaken /v1 suffix", async () => {
    const { apiBase } = await import("./user-api.js");
    expect(apiBase()).toBe("https://api.test");
  });
});

describe("errorMessage", () => {
  it("prefers the nested respondError envelope", async () => {
    const { errorMessage } = await import("./user-api.js");
    const res = new Response(
      JSON.stringify({
        error: { code: "unauthorized", type: "auth", message: "Sign in required" },
      }),
      { status: 401 },
    );
    expect(await errorMessage(res, "fallback")).toBe("Sign in required");
  });

  it("falls back to flat message then the caller default", async () => {
    const { errorMessage } = await import("./user-api.js");
    expect(
      await errorMessage(
        new Response(JSON.stringify({ message: "flat" }), { status: 400 }),
        "fallback",
      ),
    ).toBe("flat");
    expect(await errorMessage(new Response("not-json", { status: 500 }), "fallback")).toBe(
      "fallback",
    );
  });
});

describe("meGet", () => {
  it("throws the nested API message on non-OK", async () => {
    const { meGet } = await import("./user-api.js");
    const orig = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "Sign in required" } }), {
        status: 401,
      })) as typeof fetch;
    try {
      await expect(meGet("/v1/me/settings/developer", "fallback")).rejects.toThrow(
        "Sign in required",
      );
    } finally {
      globalThis.fetch = orig;
    }
  });
});
