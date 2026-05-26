import { describe, it, expect } from "bun:test";
import {
  signBotRequest,
  createSigningFetch,
  signingFetchFromRawKey,
  buildSignatureBase,
  jwkThumbprint,
} from "./web-bot-auth-sign";

async function makeKeys() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { privateJwk, publicJwk };
}

describe("signBotRequest", () => {
  it("produces headers whose signature verifies against the public key", async () => {
    const { privateJwk, publicJwk } = await makeKeys();
    const url = new URL("https://example.com/changelog");
    const headers = await signBotRequest({
      privateJwk,
      keyId: "test-key-id",
      url,
      now: 1_700_000_000_000,
    });

    expect(headers["Signature-Agent"]).toBe('"https://releases.sh"');
    expect(headers["Signature-Input"]).toContain('tag="web-bot-auth"');
    expect(headers["Signature-Input"]).toContain('keyid="test-key-id"');
    expect(headers["Signature-Input"]).toContain('alg="ed25519"');
    expect(headers["Signature-Input"]).toMatch(/^sig1=\("@authority" "signature-agent"\)/);
    expect(headers["Signature"]).toMatch(/^sig1=:.+:$/);

    // Reconstruct the base from the emitted params and verify the signature.
    const params = headers["Signature-Input"].slice("sig1=".length);
    const base = buildSignatureBase({
      authority: "example.com",
      signatureAgent: '"https://releases.sh"',
      params,
    });
    const sigB64 = headers["Signature"].slice("sig1=:".length, -1);
    const sig = Uint8Array.from(atob(sigB64), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey("jwk", publicJwk, { name: "Ed25519" }, false, [
      "verify",
    ]);
    const ok = await crypto.subtle.verify("Ed25519", key, sig, new TextEncoder().encode(base));
    expect(ok).toBe(true);
  });
});

describe("createSigningFetch", () => {
  it("attaches the three headers to the delegated request", async () => {
    const { privateJwk } = await makeKeys();
    let seen: Headers | undefined;
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = new Request(input as RequestInfo, init).headers;
      return new Response("ok");
    }) as typeof fetch;

    const signed = createSigningFetch({ privateJwk, keyId: "k", fetchImpl: fakeFetch });
    await signed("https://example.com/page");

    expect(seen?.get("signature-agent")).toBe('"https://releases.sh"');
    expect(seen?.get("signature-input")).toContain('tag="web-bot-auth"');
    expect(seen?.get("signature")).toMatch(/^sig1=:.+:$/);
  });

  it("fails open: delegates unsigned when signing throws", async () => {
    let seen: Headers | undefined;
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = new Request(input as RequestInfo, init).headers;
      return new Response("ok");
    }) as typeof fetch;
    // An invalid JWK forces importKey to throw inside the signer.
    const signed = createSigningFetch({
      privateJwk: { kty: "OKP", crv: "Ed25519" } as JsonWebKey,
      keyId: "k",
      fetchImpl: fakeFetch,
    });
    const res = await signed("https://example.com/page");
    expect(res.status).toBe(200);
    expect(seen?.get("signature")).toBeNull();
  });
});

describe("signingFetchFromRawKey", () => {
  it("derives the keyId from the key and signs the request", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
    const expectedKeyId = await jwkThumbprint(privateJwk);

    let seen: Headers | undefined;
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = new Request(input as RequestInfo, init).headers;
      return new Response("ok");
    }) as typeof fetch;

    const signed = await signingFetchFromRawKey(JSON.stringify(privateJwk), fakeFetch);
    await signed("https://example.com/page");

    expect(seen?.get("signature-input")).toContain(`keyid="${expectedKeyId}"`);
    expect(seen?.get("signature")).toMatch(/^sig1=:.+:$/);
  });

  it("throws on a malformed key so callers own the fail-open policy", async () => {
    await expect(signingFetchFromRawKey("not json")).rejects.toThrow();
  });

  it("throws on valid JSON that is not a usable Ed25519 JWK", async () => {
    // Parses fine, but the wrong key type must still fail fast at setup.
    await expect(signingFetchFromRawKey('{"kty":"oct","k":"AAAA"}')).rejects.toThrow();
  });
});

describe("jwkThumbprint", () => {
  it("matches the known Cloudflare Ed25519 vector", async () => {
    const tp = await jwkThumbprint({
      kty: "OKP",
      crv: "Ed25519",
      x: "JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs",
    } as JsonWebKey);
    expect(tp).toBe("poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U");
  });

  it("is identical for the private and public JWK of one key", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const priv = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
    const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
    expect(await jwkThumbprint(priv)).toBe(await jwkThumbprint(pub));
  });
});
