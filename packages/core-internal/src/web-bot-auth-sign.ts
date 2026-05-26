// Web Crypto only — works in Workers, Bun, browsers. No node:crypto.
// Signs outbound requests per RFC 9421 with the minimal Cloudflare-compatible
// component set ("@authority" "signature-agent"), tag="web-bot-auth".
import {
  WEB_BOT_AUTH_SIGNATURE_AGENT,
  WEB_BOT_AUTH_TAG,
} from "@buildinternet/releases-core/web-bot-auth";

const SIG_LABEL = "sig1";
const SIG_VALIDITY_SECONDS = 300;

function b64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < view.length; i++) s += String.fromCharCode(view[i]);
  return btoa(s);
}

/** Serialized Signature-Agent header value (sf-string, double-quoted). */
function signatureAgentValue(): string {
  return `"${WEB_BOT_AUTH_SIGNATURE_AGENT}"`;
}

/**
 * Assemble the RFC 9421 signature base for our fixed component set.
 * `params` is the inner-list + parameters string exactly as it appears after
 * `sig1=` in Signature-Input — the @signature-params line must be byte-identical.
 */
export function buildSignatureBase(args: {
  authority: string;
  signatureAgent: string;
  params: string;
}): string {
  return (
    `"@authority": ${args.authority}\n` +
    `"signature-agent": ${args.signatureAgent}\n` +
    `"@signature-params": ${args.params}`
  );
}

export interface SignArgs {
  privateJwk: JsonWebKey;
  keyId: string;
  url: URL;
  /** Epoch millis; injectable for tests. Defaults to Date.now(). */
  now?: number;
}

/** Returns the Signature, Signature-Input, and Signature-Agent headers. */
export async function signBotRequest(args: SignArgs): Promise<Record<string, string>> {
  const created = Math.floor((args.now ?? Date.now()) / 1000);
  const expires = created + SIG_VALIDITY_SECONDS;
  const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
  const nonce = b64(nonceBytes.buffer);

  const params =
    `("@authority" "signature-agent")` +
    `;created=${created};expires=${expires}` +
    `;keyid="${args.keyId}";alg="ed25519";nonce="${nonce}";tag="${WEB_BOT_AUTH_TAG}"`;

  const agent = signatureAgentValue();
  const base = buildSignatureBase({ authority: args.url.host, signatureAgent: agent, params });

  const key = await crypto.subtle.importKey("jwk", args.privateJwk, { name: "Ed25519" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(base));

  return {
    "Signature-Agent": agent,
    "Signature-Input": `${SIG_LABEL}=${params}`,
    Signature: `${SIG_LABEL}=:${b64(sig)}:`,
  };
}

/** RFC 7638 JWK thumbprint (base64url, unpadded) of an OKP/Ed25519 key. */
export async function jwkThumbprint(jwk: JsonWebKey): Promise<string> {
  // Fail fast on the wrong key shape so a malformed secret surfaces here (at
  // signer setup) rather than later inside crypto.subtle.importKey / signing.
  if (
    jwk.kty !== "OKP" ||
    jwk.crv !== "Ed25519" ||
    typeof jwk.x !== "string" ||
    jwk.x.length === 0
  ) {
    throw new Error(
      'web-bot-auth: invalid Ed25519 JWK (expected kty="OKP", crv="Ed25519", non-empty x)',
    );
  }
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  const view = new Uint8Array(digest);
  let s = "";
  for (let i = 0; i < view.length; i++) s += String.fromCharCode(view[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface SigningFetchArgs {
  privateJwk: JsonWebKey;
  keyId: string;
  /** Underlying fetch; defaults to global fetch. Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Wrap fetch so every request carries Web Bot Auth headers. Fail-open: if
 * signing throws, the request is sent unsigned. Use for GET/HEAD content fetches.
 */
export function createSigningFetch(args: SigningFetchArgs): typeof fetch {
  const base = args.fetchImpl ?? fetch;
  const signed = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input instanceof URL ? input.href : input, init);
    try {
      const extra = await signBotRequest({
        privateJwk: args.privateJwk,
        keyId: args.keyId,
        url: new URL(req.url),
      });
      const headers = new Headers(req.headers);
      for (const [k, v] of Object.entries(extra)) headers.set(k, v);
      return base(new Request(req, { headers }));
    } catch {
      return base(req);
    }
  };
  return signed as typeof fetch;
}

/**
 * Build a signing fetch from a raw private-key JSON string: parse the JWK,
 * derive its RFC 7638 thumbprint as the `keyId`, and wrap fetch. The keyId is
 * always derived from the key that signs (never read from the committed public
 * constant) so it identifies the signing key even if the directory disagrees.
 *
 * Throws on a malformed key (JSON parse or thumbprint failure) — callers own
 * the fail-open / observability policy. `fetchImpl` is injectable for tests.
 */
export async function signingFetchFromRawKey(
  rawPrivateKey: string,
  fetchImpl?: typeof fetch,
): Promise<typeof fetch> {
  const privateJwk = JSON.parse(rawPrivateKey) as JsonWebKey;
  const keyId = await jwkThumbprint(privateJwk);
  return createSigningFetch({ privateJwk, keyId, ...(fetchImpl ? { fetchImpl } : {}) });
}
