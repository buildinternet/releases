import { describe, it, expect } from "bun:test";
import { makeBotFetch } from "./web-bot-auth-fetch";

async function privateJwkString(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
}

describe("makeBotFetch", () => {
  it("returns plain fetch when disabled", async () => {
    const f = await makeBotFetch({ WEB_BOT_AUTH_ENABLED: "false" });
    expect(f).toBe(fetch);
  });

  it("returns plain fetch when the binding is missing", async () => {
    const f = await makeBotFetch({ WEB_BOT_AUTH_ENABLED: "true" });
    expect(f).toBe(fetch);
  });

  it("returns a signing fetch when enabled + key present", async () => {
    const jwk = await privateJwkString();
    const f = await makeBotFetch({
      WEB_BOT_AUTH_ENABLED: "true",
      WEB_BOT_AUTH_PRIVATE_KEY: { get: async () => jwk },
    });
    expect(f).not.toBe(fetch);
  });

  it("fails open to plain fetch on a malformed key", async () => {
    const f = await makeBotFetch({
      WEB_BOT_AUTH_ENABLED: "true",
      WEB_BOT_AUTH_PRIVATE_KEY: { get: async () => "not json" },
    });
    expect(f).toBe(fetch);
  });

  it("fails open when the secret read rejects", async () => {
    const f = await makeBotFetch({
      WEB_BOT_AUTH_ENABLED: "true",
      WEB_BOT_AUTH_PRIVATE_KEY: {
        get: async () => {
          throw new Error("unavailable");
        },
      },
    });
    expect(f).toBe(fetch);
  });
});
