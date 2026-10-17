import { describe, it, expect, afterEach } from "bun:test";
import { GET } from "./.well-known/http-message-signatures-directory/route";
import { isWebBotAuthProvisioned } from "@buildinternet/releases-core/web-bot-auth";

// This test lives one level up from the route it covers: `bun test` skips
// dot-directories, so a test co-located inside `.well-known/` is never
// discovered by the suite (it would only run when invoked by explicit path).
// Keeping it in `app/` and importing the route by path keeps it in CI.
// Signing with the real key is covered by `signDirectoryResponse`'s tests in
// core-internal; the private key never exists in CI.
const URL_ = "https://releases.sh/.well-known/http-message-signatures-directory";
const saved = process.env.WEB_BOT_AUTH_PRIVATE_KEY;
afterEach(() => {
  if (saved === undefined) delete process.env.WEB_BOT_AUTH_PRIVATE_KEY;
  else process.env.WEB_BOT_AUTH_PRIVATE_KEY = saved;
});

describe("GET /.well-known/http-message-signatures-directory", () => {
  it("serves an unsigned JWKS without a key, or 404s unprovisioned", async () => {
    delete process.env.WEB_BOT_AUTH_PRIVATE_KEY;
    const res = await GET(new Request(URL_));
    if (!isWebBotAuthProvisioned()) {
      expect(res.status).toBe(404);
      return;
    }
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/http-message-signatures-directory+json",
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("signature")).toBeNull();
    const json = (await res.json()) as { keys: Array<{ crv: string }> };
    expect(json.keys[0].crv).toBe("Ed25519");
  });

  it("refuses to sign with a key that isn't the published one", async () => {
    if (!isWebBotAuthProvisioned()) return;
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    process.env.WEB_BOT_AUTH_PRIVATE_KEY = JSON.stringify(
      await crypto.subtle.exportKey("jwk", pair.privateKey),
    );
    const res = await GET(new Request(URL_));
    expect(res.status).toBe(200);
    expect(res.headers.get("signature")).toBeNull();
  });

  it("serves unsigned when the key is malformed", async () => {
    if (!isWebBotAuthProvisioned()) return;
    process.env.WEB_BOT_AUTH_PRIVATE_KEY = "not json";
    const res = await GET(new Request(URL_));
    expect(res.status).toBe(200);
    expect(res.headers.get("signature")).toBeNull();
  });
});
