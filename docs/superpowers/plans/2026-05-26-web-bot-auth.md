# Web Bot Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish an Ed25519 JWKS directory on releases.sh and sign the crawler's direct outbound content fetches with HTTP Message Signatures (RFC 9421) so the crawler can register as a Cloudflare Verified Bot.

**Architecture:** A non-secret public key + directory builder live in `@buildinternet/releases-core/web-bot-auth`. A Web-Crypto Ed25519 request signer + a `createSigningFetch` wrapper live in `@releases/core-internal/web-bot-auth-sign`. Each Worker builds the signing fetch from a `WEB_BOT_AUTH_PRIVATE_KEY` Secrets Store binding (gated by `WEB_BOT_AUTH_ENABLED`) and injects it into the existing `fetchImpl`/`fetchFn` injection points. The web frontend serves the directory and a `/bot` docs page. All signing is fail-open.

**Tech Stack:** TypeScript, Bun, Cloudflare Workers (Web Crypto `crypto.subtle` Ed25519), Next.js 16 App Router, Drizzle, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-05-26-web-bot-auth-design.md`

---

## Prerequisites

- [ ] **Install deps in this worktree** (workspace packages don't resolve otherwise)

Run: `bun install` (from the repository / worktree root)
Expected: completes without error; `node_modules` present in the working tree.

## Scope note (read before starting)

The signer is wired into the three **content-retrieval** fetch paths (all have a Worker
`env`/deps object in scope): the feed body GET (`fetchAndParseFeed` via `fetchOne`), the
feed-enrich article GET, and the scrape-path page retrieval (`probeUpstreamStatus` +
`fetchMarkdownUrl`). The **poll-phase conditional probes** (`headCheckUrl` / `bodyHashCheck`
inside `pollOne` / `pollScrapeOrAgentByQuirk`) are wired in Task 8, which threads the signed
fetch through `pollOne`'s two callers. `discoverFeed` (eval-time + a script only — no
production crawler caller) is made _signable_ in Task 5 but is not wired to a signed fetch in
production. Browser Rendering / `/crawl` traffic is intentionally untouched (Cloudflare
signs it under its own identity).

---

## Task 1: Key material + directory builder (`packages/core`)

**Files:**

- Create: `packages/core/src/web-bot-auth.ts`
- Modify: `packages/core/package.json` (add export)
- Test: `packages/core/src/web-bot-auth.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/web-bot-auth.test.ts
import { describe, it, expect } from "bun:test";
import {
  buildSignaturesDirectory,
  WEB_BOT_AUTH_SIGNATURE_AGENT,
  WEB_BOT_AUTH_DIRECTORY_URL,
  type Ed25519PublicJwk,
} from "./web-bot-auth";

const SAMPLE: Ed25519PublicJwk = {
  kty: "OKP",
  crv: "Ed25519",
  x: "JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs",
  kid: "poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U",
};

describe("buildSignaturesDirectory", () => {
  it("serves a JWKS with the directory content type", () => {
    const { body, contentType } = buildSignaturesDirectory(SAMPLE);
    expect(contentType).toBe("application/http-message-signatures-directory+json");
    const parsed = JSON.parse(body) as { keys: Ed25519PublicJwk[] };
    expect(parsed.keys).toHaveLength(1);
    expect(parsed.keys[0].kid).toBe(SAMPLE.kid);
    expect(parsed.keys[0].crv).toBe("Ed25519");
  });

  it("exposes the canonical agent + directory URLs", () => {
    expect(WEB_BOT_AUTH_SIGNATURE_AGENT).toBe("https://releases.sh");
    expect(WEB_BOT_AUTH_DIRECTORY_URL).toBe(
      "https://releases.sh/.well-known/http-message-signatures-directory",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/web-bot-auth.test.ts`
Expected: FAIL — `Cannot find module './web-bot-auth'`.

- [ ] **Step 3: Create the module**

```typescript
// packages/core/src/web-bot-auth.ts
/**
 * Web Bot Auth public key material + directory builder. Pure, non-secret,
 * runtime-neutral. The PRIVATE key lives only in Cloudflare Secrets Store
 * (WEB_BOT_AUTH_PRIVATE_KEY); never put it here.
 *
 * The `x`/`kid` below start empty and are filled by running
 * `bun scripts/gen-web-bot-auth-key.ts` (Task 9) and pasting the public-key
 * output. While `x` is empty the directory route returns 404 and signing stays
 * off (WEB_BOT_AUTH_ENABLED=false), so an unprovisioned deploy is inert.
 */
export interface Ed25519PublicJwk {
  kty: "OKP";
  crv: "Ed25519";
  /** base64url-encoded 32-byte public key. */
  x: string;
  /** RFC 7638 JWK thumbprint; doubles as the Signature-Input `keyid`. */
  kid: string;
}

/** Filled by scripts/gen-web-bot-auth-key.ts (Task 9). Empty = not provisioned. */
export const WEB_BOT_AUTH_PUBLIC_JWK: Ed25519PublicJwk = {
  kty: "OKP",
  crv: "Ed25519",
  x: "",
  kid: "",
};

/** Identity host. The Signature-Agent header sends this as a quoted sf-string. */
export const WEB_BOT_AUTH_SIGNATURE_AGENT = "https://releases.sh";

/** Where the directory is published (and what the form's validation URL is). */
export const WEB_BOT_AUTH_DIRECTORY_URL =
  "https://releases.sh/.well-known/http-message-signatures-directory";

/** RFC 9421 signature `tag` Cloudflare requires for verified bots. */
export const WEB_BOT_AUTH_TAG = "web-bot-auth";

export const WEB_BOT_AUTH_DIRECTORY_CONTENT_TYPE =
  "application/http-message-signatures-directory+json";

/** True once a real public key has been provisioned. */
export function isWebBotAuthProvisioned(jwk: Ed25519PublicJwk = WEB_BOT_AUTH_PUBLIC_JWK): boolean {
  return jwk.x.length > 0 && jwk.kid.length > 0;
}

/** Build the `.well-known/http-message-signatures-directory` JWKS response body. */
export function buildSignaturesDirectory(jwk: Ed25519PublicJwk = WEB_BOT_AUTH_PUBLIC_JWK): {
  body: string;
  contentType: string;
} {
  return {
    body: JSON.stringify({ keys: [jwk] }),
    contentType: WEB_BOT_AUTH_DIRECTORY_CONTENT_TYPE,
  };
}
```

- [ ] **Step 4: Add the package export**

In `packages/core/package.json`, add to the `"exports"` map (after `"./composition"`):

```json
    "./composition": "./src/composition.ts",
    "./web-bot-auth": "./src/web-bot-auth.ts"
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/core/src/web-bot-auth.test.ts`
Expected: PASS (both tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/web-bot-auth.ts packages/core/src/web-bot-auth.test.ts packages/core/package.json
git commit -m "feat(core): web-bot-auth public key material + directory builder"
```

---

## Task 2: Request signer + signing fetch (`packages/core-internal`)

**Files:**

- Create: `packages/core-internal/src/web-bot-auth-sign.ts`
- Modify: `packages/core-internal/package.json` (add export)
- Test: `packages/core-internal/src/web-bot-auth-sign.test.ts`

- [ ] **Step 1: Write the failing test** (round-trips a signature with an ephemeral key)

```typescript
// packages/core-internal/src/web-bot-auth-sign.test.ts
import { describe, it, expect } from "bun:test";
import { signBotRequest, createSigningFetch, buildSignatureBase } from "./web-bot-auth-sign";

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
      method: "GET",
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core-internal/src/web-bot-auth-sign.test.ts`
Expected: FAIL — `Cannot find module './web-bot-auth-sign'`.

- [ ] **Step 3: Create the signer module**

```typescript
// packages/core-internal/src/web-bot-auth-sign.ts
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
  method: string;
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
    const req = new Request(input as RequestInfo, init);
    try {
      const extra = await signBotRequest({
        privateJwk: args.privateJwk,
        keyId: args.keyId,
        url: new URL(req.url),
        method: req.method,
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
```

- [ ] **Step 4: Add the package export**

In `packages/core-internal/package.json`, add to `"exports"` (after `"./webhook-sign"`):

```json
    "./webhook-sign": "./src/webhook-sign.ts",
    "./web-bot-auth-sign": "./src/web-bot-auth-sign.ts",
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/core-internal/src/web-bot-auth-sign.test.ts`
Expected: PASS (all three tests). If the Ed25519 algorithm name is rejected by the
runtime, the test for round-trip will fail — re-run on Bun ≥1.3.13 which supports it.

- [ ] **Step 6: Commit**

```bash
git add packages/core-internal/src/web-bot-auth-sign.ts packages/core-internal/src/web-bot-auth-sign.test.ts packages/core-internal/package.json
git commit -m "feat(core-internal): Ed25519 web-bot-auth request signer + signing fetch"
```

---

## Task 3: Directory route + robots allow (`web`)

**Files:**

- Create: `web/src/app/.well-known/http-message-signatures-directory/route.ts`
- Modify: `web/src/app/robots.ts`
- Test: `web/src/app/.well-known/http-message-signatures-directory/route.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// web/src/app/.well-known/http-message-signatures-directory/route.test.ts
import { describe, it, expect } from "bun:test";
import { GET } from "./route";

describe("GET /.well-known/http-message-signatures-directory", () => {
  it("returns 404 until a key is provisioned, else a JWKS", async () => {
    const res = GET();
    const { isWebBotAuthProvisioned } = await import("@buildinternet/releases-core/web-bot-auth");
    if (isWebBotAuthProvisioned()) {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(
        "application/http-message-signatures-directory+json",
      );
      const json = (await res.json()) as { keys: Array<{ crv: string }> };
      expect(json.keys[0].crv).toBe("Ed25519");
    } else {
      expect(res.status).toBe(404);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test web/src/app/.well-known/http-message-signatures-directory/route.test.ts`
Expected: FAIL — `Cannot find module './route'`.

- [ ] **Step 3: Create the route handler**

```typescript
// web/src/app/.well-known/http-message-signatures-directory/route.ts
import {
  WEB_BOT_AUTH_PUBLIC_JWK,
  buildSignaturesDirectory,
  isWebBotAuthProvisioned,
} from "@buildinternet/releases-core/web-bot-auth";

export const dynamic = "force-static";
export const revalidate = false;

/** Publishes our Ed25519 public key(s) for Web Bot Auth request verification. */
export function GET(): Response {
  if (!isWebBotAuthProvisioned()) {
    return new Response("Web Bot Auth key not provisioned", { status: 404 });
  }
  const { body, contentType } = buildSignaturesDirectory(WEB_BOT_AUTH_PUBLIC_JWK);
  return new Response(body, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
```

- [ ] **Step 4: Allow the directory path in robots.ts**

In `web/src/app/robots.ts`, change the `rules` object so the directory is crawlable while
keeping the rest of `/.well-known/` disallowed:

```typescript
    rules: {
      userAgent: "*",
      allow: ["/", "/.well-known/http-message-signatures-directory"],
      disallow: ["/api/", "/.well-known/"],
    },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test web/src/app/.well-known/http-message-signatures-directory/route.test.ts`
Expected: PASS (404 branch before provisioning; flips to the 200 branch after Task 9).

- [ ] **Step 6: Commit**

```bash
git add web/src/app/.well-known/http-message-signatures-directory/ web/src/app/robots.ts
git commit -m "feat(web): serve Web Bot Auth signatures directory + allow it in robots"
```

---

## Task 4: Bot documentation page (`/bot`)

**Files:**

- Create: `web/src/app/bot/page.tsx`

- [ ] **Step 1: Create the page**

```tsx
// web/src/app/bot/page.tsx
import type { Metadata } from "next";
import {
  WEB_BOT_AUTH_DIRECTORY_URL,
  WEB_BOT_AUTH_SIGNATURE_AGENT,
} from "@buildinternet/releases-core/web-bot-auth";

export const metadata: Metadata = {
  title: "Releases crawler",
  description:
    "How the Releases crawler identifies itself, what it fetches, and how to control its access.",
};

const USER_AGENT = "releases/0.1 (+https://releases.sh)";

export default function BotPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16 prose dark:prose-invert">
      <h1>The Releases crawler</h1>
      <p>
        Releases (<a href="https://releases.sh">releases.sh</a>) is a changelog indexer and registry
        for AI agents and developers. Our crawler fetches publicly available changelog and
        release-note pages so they can be searched and summarized.
      </p>

      <h2>How to identify our requests</h2>
      <ul>
        <li>
          <strong>User-Agent:</strong> <code>{USER_AGENT}</code>
        </li>
        <li>
          <strong>Web Bot Auth:</strong> direct requests are signed with HTTP Message Signatures.
          Our public keys are published at{" "}
          <a href={WEB_BOT_AUTH_DIRECTORY_URL}>{WEB_BOT_AUTH_DIRECTORY_URL}</a> and our{" "}
          <code>Signature-Agent</code> is <code>{WEB_BOT_AUTH_SIGNATURE_AGENT}</code>.
        </li>
        <li>
          Some JavaScript-rendered pages are fetched via Cloudflare Browser Rendering, which
          identifies itself separately as Cloudflare Browser Rendering.
        </li>
      </ul>

      <h2>Crawl behavior</h2>
      <ul>
        <li>
          We honor <code>robots.txt</code>.
        </li>
        <li>
          Polling backs off automatically (1h–48h) when a source stops changing, and we fetch each
          source on a per-source interval — we do not hammer origins.
        </li>
        <li>We fetch only changelog / release-note content, not full sites.</li>
      </ul>

      <h2>Contact &amp; exclusion</h2>
      <p>
        To request that we stop crawling a source, email{" "}
        <a href="mailto:hello@buildinternet.com">hello@buildinternet.com</a> or disallow{" "}
        <code>{USER_AGENT}</code> in your <code>robots.txt</code>.
      </p>
    </main>
  );
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `cd web && npx tsc --noEmit`
Expected: no errors referencing `bot/page.tsx`. (If the project lacks Tailwind `prose`
classes, the page still renders; classes are cosmetic.)

- [ ] **Step 3: Commit**

```bash
git add web/src/app/bot/page.tsx
git commit -m "feat(web): public /bot crawler documentation page"
```

---

## Task 5: Make feed.ts fetches signable (`packages/adapters/src/feed.ts`)

Thread an optional `fetchImpl: typeof fetch = fetch` through the external-fetch functions so
a caller can inject the signing fetch. Backward-compatible (defaults to global `fetch`).

**Files:**

- Modify: `packages/adapters/src/feed.ts`
- Test: `packages/adapters/src/feed-signing.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/adapters/src/feed-signing.test.ts
import { describe, it, expect } from "bun:test";
import { headCheckUrl, bodyHashCheck, fetchAndParseFeed } from "./feed";

function recordingFetch() {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    return new Response("", { status: 304 });
  }) as typeof fetch;
  return { calls, impl };
}

describe("feed.ts fetchImpl injection", () => {
  it("headCheckUrl uses the injected fetchImpl", async () => {
    const { calls, impl } = recordingFetch();
    await headCheckUrl("https://example.com/feed.xml", {}, impl);
    expect(calls).toEqual(["https://example.com/feed.xml"]);
  });

  it("bodyHashCheck uses the injected fetchImpl", async () => {
    const { calls, impl } = recordingFetch();
    await bodyHashCheck("https://example.com/page", undefined, undefined, impl);
    expect(calls).toEqual(["https://example.com/page"]);
  });

  it("fetchAndParseFeed uses the injected fetchImpl", async () => {
    const { calls, impl } = recordingFetch();
    await fetchAndParseFeed("https://example.com/feed.xml", "rss", undefined, undefined, impl);
    expect(calls).toEqual(["https://example.com/feed.xml"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/adapters/src/feed-signing.test.ts`
Expected: FAIL — extra argument is ignored / global fetch hits the network (or type error
once compiled). It must not pass yet.

- [ ] **Step 3: Add `fetchImpl` to `headCheckUrl`** (`feed.ts:327`)

Change the signature and the `fetch` call:

```typescript
export async function headCheckUrl(
  url: string,
  stored: { etag?: string; lastModified?: string; contentLength?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<HeadCheckResult> {
```

and inside, replace `await fetch(url, {` with `await fetchImpl(url, {`.

- [ ] **Step 4: Add `fetchImpl` to `bodyHashCheck`** (`feed.ts:418`)

```typescript
export async function bodyHashCheck(
  url: string,
  storedHash: string | undefined,
  opts?: { filter?: boolean },
  fetchImpl: typeof fetch = fetch,
): Promise<BodyHashCheckResult> {
```

and replace `await fetch(url, {` with `await fetchImpl(url, {`.

- [ ] **Step 5: Add `fetchImpl` to `fetchAndParseFeed`** (`feed.ts:246`)

```typescript
export async function fetchAndParseFeed(
  feedUrl: string,
  feedType: FeedType,
  options?: FetchOptions,
  headers?: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<{
```

and replace both `await fetch(feedUrl, ...)` occurrences in the function body with
`await fetchImpl(feedUrl, ...)`. (There are two: the initial GET and any retry.)

- [ ] **Step 6: Add `fetchImpl` to `discoverFeed` and its two helpers** (`feed.ts:92,134,165`)

`discoverFeed`:

```typescript
export async function discoverFeed(
  pageUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoveredFeed | null> {
  const fromHead = await discoverFromHead(pageUrl, fetchImpl);
```

and pass `fetchImpl` to both `probeFeedPath(...)` call sites:
`probeFeedPath(base.origin, \`${trimmedPath}${suffix}\`, fetchImpl)`and`probeFeedPath(base.origin, path, fetchImpl)`.

`discoverFromHead`:

```typescript
async function discoverFromHead(
  pageUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoveredFeed | null> {
  try {
    const res = await fetchImpl(pageUrl, {
```

`probeFeedPath`:

```typescript
async function probeFeedPath(
  origin: string,
  path: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoveredFeed | null> {
  const probeUrl = `${origin}${path}`;
  const res = await fetchImpl(probeUrl, {
```

and replace the inner GET fallback `await fetch(probeUrl, {` with `await fetchImpl(probeUrl, {`.

- [ ] **Step 7: Run test to verify it passes**

Run: `bun test packages/adapters/src/feed-signing.test.ts`
Expected: PASS (all three).

- [ ] **Step 8: Run the adapters' existing feed tests to confirm no regressions**

Run: `bun test packages/adapters/src/feed`
Expected: PASS (no behavior change — defaults preserve global `fetch`).

- [ ] **Step 9: Commit**

```bash
git add packages/adapters/src/feed.ts packages/adapters/src/feed-signing.test.ts
git commit -m "feat(adapters): inject fetchImpl into feed.ts outbound fetches"
```

---

## Task 6: API worker — `makeBotFetch` helper + Env types

**Files:**

- Create: `workers/api/src/lib/web-bot-auth-fetch.ts`
- Modify: `workers/api/src/cron/poll-fetch.ts` (`FetchOneEnv` interface, lines ~604–608)
- Modify: `workers/api/src/index.ts` (`Env.Bindings`, around line 44)
- Test: `workers/api/src/lib/web-bot-auth-fetch.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// workers/api/src/lib/web-bot-auth-fetch.test.ts
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test workers/api/src/lib/web-bot-auth-fetch.test.ts`
Expected: FAIL — `Cannot find module './web-bot-auth-fetch'`.

- [ ] **Step 3: Create the helper**

```typescript
// workers/api/src/lib/web-bot-auth-fetch.ts
import { createSigningFetch } from "@releases/core-internal/web-bot-auth-sign";
import {
  WEB_BOT_AUTH_PUBLIC_JWK,
  isWebBotAuthProvisioned,
} from "@buildinternet/releases-core/web-bot-auth";

export interface WebBotAuthEnv {
  WEB_BOT_AUTH_ENABLED?: string;
  WEB_BOT_AUTH_PRIVATE_KEY?: { get(): Promise<string> };
}

/**
 * Build the outbound fetch the crawler should use for third-party content.
 * Returns global `fetch` unless signing is enabled AND a private key is bound
 * AND a public key has been provisioned (so keyid matches the directory).
 * Fail-open: any error returns global `fetch`.
 */
export async function makeBotFetch(env: WebBotAuthEnv): Promise<typeof fetch> {
  if (env.WEB_BOT_AUTH_ENABLED !== "true") return fetch;
  if (!isWebBotAuthProvisioned()) return fetch;
  try {
    const raw = await env.WEB_BOT_AUTH_PRIVATE_KEY?.get();
    if (!raw) return fetch;
    const privateJwk = JSON.parse(raw) as JsonWebKey;
    return createSigningFetch({ privateJwk, keyId: WEB_BOT_AUTH_PUBLIC_JWK.kid });
  } catch {
    return fetch;
  }
}
```

- [ ] **Step 4: Extend `FetchOneEnv`** in `workers/api/src/cron/poll-fetch.ts` (inside the
      interface ending at line 608, after `CLOUDFLARE_API_TOKEN`):

```typescript
  CLOUDFLARE_API_TOKEN?: { get(): Promise<string> };
  WEB_BOT_AUTH_ENABLED?: string;
  WEB_BOT_AUTH_PRIVATE_KEY?: { get(): Promise<string> };
}
```

- [ ] **Step 5: Add the bindings to the worker `Env`** in `workers/api/src/index.ts` (in the
      `Env.Bindings` block near line 44, after `WEBHOOK_HMAC_MASTER?`):

```typescript
    WEBHOOK_HMAC_MASTER?: SecretBinding;
    WEB_BOT_AUTH_PRIVATE_KEY?: SecretBinding;
    WEB_BOT_AUTH_ENABLED?: string;
```

- [ ] **Step 6: Run test + type-check**

Run: `bun test workers/api/src/lib/web-bot-auth-fetch.test.ts`
Expected: PASS (all three).
Run: `cd workers/api && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add workers/api/src/lib/web-bot-auth-fetch.ts workers/api/src/lib/web-bot-auth-fetch.test.ts workers/api/src/cron/poll-fetch.ts workers/api/src/index.ts
git commit -m "feat(api): makeBotFetch helper + WEB_BOT_AUTH env bindings"
```

---

## Task 7: Wire signing into the content-fetch paths (api worker)

**Files:**

- Modify: `workers/api/src/cron/poll-fetch.ts` (`fetchOne`, the `fetchAndParseFeed` call at line ~1035)
- Modify: `workers/api/src/cron/feed-enrich.ts` (`buildEnrichDeps`, `EnrichDepsEnv`)

- [ ] **Step 1: Sign the feed body GET in `fetchOne`**

In `workers/api/src/cron/poll-fetch.ts`, add the import near the other local imports (top of
file, alongside the `@releases/adapters/feed.js` import):

```typescript
import { makeBotFetch } from "../lib/web-bot-auth-fetch.js";
```

In `fetchOne` (line 956, `env: FetchOneEnv` in scope), just before the `fetchAndParseFeed`
call at line ~1035, build the signing fetch and pass it as the 5th argument:

```typescript
const botFetch = await makeBotFetch(env);
const result = await fetchAndParseFeed(
  meta.feedUrl,
  meta.feedType as "rss" | "atom" | "jsonfeed",
  { maxEntries },
  Object.keys(conditionalHeaders).length > 0 ? conditionalHeaders : undefined,
  botFetch,
);
```

- [ ] **Step 2: Sign the feed-enrich article GET**

In `workers/api/src/cron/feed-enrich.ts`:

Add to the imports (after the `getSecret` import near line 7):

```typescript
import { makeBotFetch } from "../lib/web-bot-auth-fetch.js";
```

Extend `EnrichDepsEnv` (lines ~150–153) to include the bindings:

```typescript
interface EnrichDepsEnv extends AnthropicEnv {
  CLOUDFLARE_ACCOUNT_ID?: { get(): Promise<string> };
  CLOUDFLARE_API_TOKEN?: { get(): Promise<string> };
  WEB_BOT_AUTH_ENABLED?: string;
  WEB_BOT_AUTH_PRIVATE_KEY?: { get(): Promise<string> };
}
```

In `buildEnrichDeps` (line 163), build the signing fetch and pass it as `fetchImpl`:

```typescript
const fetchImpl = await makeBotFetch(env);
return { thinChars, extractArticleFn, renderFn, logEvent, fetchImpl };
```

(`EnrichDeps.fetchImpl` already exists at line ~40; `enrichFeedItem` already does
`const fetchImpl = deps.fetchImpl ?? fetch`, so no further change is needed there.)

- [ ] **Step 3: Type-check**

Run: `cd workers/api && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Run the api worker tests touching these files**

Run: `bun test workers/api/src/cron`
Expected: PASS (signing is gated off by default, so behavior is unchanged in tests).

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/cron/poll-fetch.ts workers/api/src/cron/feed-enrich.ts
git commit -m "feat(api): sign feed-body and feed-enrich content fetches"
```

---

## Task 8: Sign the poll-phase conditional probes (api worker)

Thread the signing fetch through `pollOne` (no `env`) via an `opts.signedFetch`, supplied by
its two callers, which both have a fetch env in scope.

**Files:**

- Modify: `workers/api/src/cron/poll-fetch.ts` (`pollOne` opts + `pollScrapeOrAgentByQuirk` + the 3 probe call sites)
- Modify: `workers/api/src/cron/poll-fetch.ts:137` and `workers/api/src/workflows/poll-and-fetch.ts:434` (callers)

- [ ] **Step 1: Add `signedFetch` to `pollOne` opts** (`poll-fetch.ts:310`)

```typescript
export async function pollOne(
  db: ReturnType<typeof drizzle>,
  source: Source,
  now: Date,
  opts?: { changeDetectEnabled?: boolean; playbookNotes?: string | null; signedFetch?: typeof fetch },
): Promise<PollResult> {
```

- [ ] **Step 2: Use it for the feed `headCheckUrl`** (`poll-fetch.ts:358`)

```typescript
const result = await headCheckUrl(
  meta.feedUrl,
  {
    etag: meta.feedEtag,
    lastModified: meta.feedLastModified,
    contentLength: meta.feedContentLength,
  },
  opts?.signedFetch,
);
```

- [ ] **Step 3: Pass it into `pollScrapeOrAgentByQuirk`** (`poll-fetch.ts:349`)

```typescript
return pollScrapeOrAgentByQuirk(
  db,
  source,
  meta,
  now,
  opts.playbookNotes ?? null,
  opts?.signedFetch,
);
```

- [ ] **Step 4: Accept + use it in `pollScrapeOrAgentByQuirk`** (`poll-fetch.ts:424`)

```typescript
async function pollScrapeOrAgentByQuirk(
  db: ReturnType<typeof drizzle>,
  source: Source,
  meta: SourceMetadata,
  now: Date,
  playbookNotes: string | null,
  signedFetch?: typeof fetch,
): Promise<PollResult> {
```

Then thread it into the two probes (lines 486 and 499):

```typescript
const result = await bodyHashCheck(
  probeUrl,
  meta.pageContentHash,
  { filter: detector === "body-hash-filtered" },
  signedFetch,
);
```

```typescript
const result = await headCheckUrl(
  probeUrl,
  {
    etag: meta.pageEtag,
    lastModified: meta.pageLastModified,
    contentLength: meta.pageContentLength,
  },
  signedFetch,
);
```

(`headCheckUrl` / `bodyHashCheck` default to global `fetch` when `signedFetch` is
`undefined`, so callers that don't supply it are unaffected.)

- [ ] **Step 5: Supply `signedFetch` from the cron caller** (`poll-fetch.ts:137`)

This call site is inside a function that has the fetch env in scope (the same `env` later
passed to `fetchOne` at line 198). Build it once and pass it:

```typescript
return pollOne(db, source, now, {
  changeDetectEnabled,
  playbookNotes,
  signedFetch: await makeBotFetch(env),
});
```

(`makeBotFetch` is already imported in this file from Task 7.) If `env` is not in scope at
line 137, read upward to the enclosing function and confirm — it is the same `env` used at
line 198; if the enclosing function does not receive `env`, thread it in.

- [ ] **Step 6: Supply `signedFetch` from the workflow caller** (`poll-and-fetch.ts:434`)

Add the import at the top of `workers/api/src/workflows/poll-and-fetch.ts`:

```typescript
import { makeBotFetch } from "../lib/web-bot-auth-fetch.js";
```

At the `pollOne` call (line 434), pass `signedFetch` built from the same env used for
`fetchOne` at line 509 (`fetchEnv`):

```typescript
return await pollOne(db, source, now, {
  changeDetectEnabled,
  playbookNotes,
  signedFetch: await makeBotFetch(fetchEnv),
});
```

Match the existing `opts` keys actually present at this call site; only add `signedFetch`.

- [ ] **Step 7: Type-check + tests**

Run: `cd workers/api && npx tsc --noEmit`
Expected: no new errors.
Run: `bun test workers/api/src/cron`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add workers/api/src/cron/poll-fetch.ts workers/api/src/workflows/poll-and-fetch.ts
git commit -m "feat(api): sign poll-phase conditional probes via threaded signedFetch"
```

---

## Task 9: Discovery worker — sign the scrape path

**Files:**

- Modify: `workers/discovery/src/scrape-fetch.ts` (`ScrapeEnv`, `fetchMarkdownUrl`, the two probe call sites)
- Modify: `workers/discovery/src/managed-agents-session.ts` (`scrapeFetch` env literal ~line 484; read the binding)

- [ ] **Step 1: Add `signedFetch` to `ScrapeEnv`** (`scrape-fetch.ts:65`)

After `extractToolLoopEnabled?: string;`:

```typescript
  /** Signed outbound fetch for third-party content; falls back to global fetch. */
  signedFetch?: typeof fetch;
}
```

- [ ] **Step 2: Use `env.signedFetch` for `probeUpstreamStatus`** (`scrape-fetch.ts:565`)

```typescript
const probe = await probeUpstreamStatus(source.url, env.signedFetch ?? fetch);
```

- [ ] **Step 3: Add a `fetchFn` param to `fetchMarkdownUrl`** (`scrape-fetch.ts:453`)

```typescript
async function fetchMarkdownUrl(url: string, fetchFn: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchFn(url, {
```

and at the call site (`scrape-fetch.ts:592`):

```typescript
markdown = await fetchMarkdownUrl(meta.markdownUrl, env.signedFetch ?? fetch);
```

- [ ] **Step 4: Populate `signedFetch` in the discovery session** (`managed-agents-session.ts:484`)

The discovery worker already resolves secrets via `getSecret(this.env.X)`. Add a
`WEB_BOT_AUTH_PRIVATE_KEY` read alongside the existing CF secret reads (after line 478's
`gatewayToken` resolution) and build the signing fetch:

```typescript
const webBotAuthKey =
  this.env.WEB_BOT_AUTH_ENABLED === "true"
    ? ((await getSecret(this.env.WEB_BOT_AUTH_PRIVATE_KEY).catch(() => null)) ?? "")
    : "";
const signedFetch = await buildDiscoverySignedFetch(webBotAuthKey);
```

Add this helper near the top of `managed-agents-session.ts` (after imports):

```typescript
import { createSigningFetch } from "@releases/core-internal/web-bot-auth-sign";
import {
  WEB_BOT_AUTH_PUBLIC_JWK,
  isWebBotAuthProvisioned,
} from "@buildinternet/releases-core/web-bot-auth";

/** Signing fetch for the scrape path; global fetch when unprovisioned/disabled. */
async function buildDiscoverySignedFetch(privateKeyRaw: string): Promise<typeof fetch> {
  if (!privateKeyRaw || !isWebBotAuthProvisioned()) return fetch;
  try {
    const privateJwk = JSON.parse(privateKeyRaw) as JsonWebKey;
    return createSigningFetch({ privateJwk, keyId: WEB_BOT_AUTH_PUBLIC_JWK.kid });
  } catch {
    return fetch;
  }
}
```

Then add `signedFetch` to the `scrapeFetch(...)` env object literal (after
`extractToolLoopEnabled: this.env.EXTRACT_TOOLLOOP_ENABLED,` at line 494):

```typescript
                  extractToolLoopEnabled: this.env.EXTRACT_TOOLLOOP_ENABLED,
                  signedFetch,
```

- [ ] **Step 5: Add the bindings to the discovery worker `Env` type**

Find the discovery worker's `Env` interface (grep `WEB_BOT_AUTH\|EXTRACT_TOOLLOOP_ENABLED`
across `workers/discovery/src/`; it is the interface that declares `EXTRACT_TOOLLOOP_ENABLED`
and `CLOUDFLARE_API_TOKEN`). Add:

```typescript
  WEB_BOT_AUTH_ENABLED?: string;
  WEB_BOT_AUTH_PRIVATE_KEY?: { get(): Promise<string | null> };
```

Match the existing `getSecret`-compatible binding shape used by `CLOUDFLARE_API_TOKEN` in
that same interface (copy its exact type).

- [ ] **Step 6: Type-check**

Run: `cd workers/discovery && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add workers/discovery/src/scrape-fetch.ts workers/discovery/src/managed-agents-session.ts
git commit -m "feat(discovery): sign scrape-path page fetches with web-bot-auth"
```

---

## Task 10: Wrangler bindings (api + discovery, prod + staging)

**Files:**

- Modify: `workers/api/wrangler.jsonc`
- Modify: `workers/discovery/wrangler.jsonc`

- [ ] **Step 1: api worker — prod `secrets_store_secrets`**

In `workers/api/wrangler.jsonc`, in the top-level `secrets_store_secrets` array (next to the
`WEBHOOK_HMAC_MASTER` entry, ~line 338), add:

```jsonc
    {
      "binding": "WEB_BOT_AUTH_PRIVATE_KEY",
      "store_id": "a887a71cab084105b79706df23380723",
      "secret_name": "WEB_BOT_AUTH_PRIVATE_KEY",
    },
```

In the top-level `vars` block, add:

```jsonc
    "WEB_BOT_AUTH_ENABLED": "false",
```

- [ ] **Step 2: api worker — staging block**

In the `[env.staging]` `secrets_store_secrets` array (~line 540), add the same
`WEB_BOT_AUTH_PRIVATE_KEY` entry, and in the staging `vars` add `"WEB_BOT_AUTH_ENABLED": "false"`.

- [ ] **Step 3: discovery worker — prod + staging**

In `workers/discovery/wrangler.jsonc`, add the same `WEB_BOT_AUTH_PRIVATE_KEY`
`secrets_store_secrets` entry to BOTH the prod array (~line 84) and the staging array
(~line 170), and add `"WEB_BOT_AUTH_ENABLED": "false"` to both `vars` blocks.

- [ ] **Step 4: Validate config parses**

Run: `cd workers/api && npx wrangler deploy --dry-run --outdir /tmp/wba-api 2>&1 | tail -5`
Expected: dry-run completes (parses bindings) without a JSON/binding error. Repeat for
`workers/discovery`. (A dry-run does not require credentials and does not deploy.)

- [ ] **Step 5: Commit**

```bash
git add workers/api/wrangler.jsonc workers/discovery/wrangler.jsonc
git commit -m "chore(workers): add WEB_BOT_AUTH bindings (disabled by default)"
```

---

## Task 11: Key generation script (run by the user)

**Files:**

- Create: `scripts/gen-web-bot-auth-key.ts`

- [ ] **Step 1: Create the script**

```typescript
// scripts/gen-web-bot-auth-key.ts
// Generates an Ed25519 keypair for Web Bot Auth. Prints:
//  1) the PRIVATE JWK to store in Cloudflare Secrets Store as WEB_BOT_AUTH_PRIVATE_KEY
//  2) the PUBLIC JWK + RFC 7638 thumbprint to paste into
//     packages/core/src/web-bot-auth.ts (WEB_BOT_AUTH_PUBLIC_JWK).
// Run: bun scripts/gen-web-bot-auth-key.ts

function b64url(bytes: ArrayBuffer): string {
  const v = new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < v.length; i++) s += String.fromCharCode(v[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function thumbprint(jwk: JsonWebKey): Promise<string> {
  // RFC 7638: lexicographic members for OKP = crv, kty, x.
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return b64url(digest);
}

const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
  "sign",
  "verify",
])) as CryptoKeyPair;

const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
const kid = await thumbprint(publicJwk);

console.log("\n=== PRIVATE KEY — store in Secrets Store as WEB_BOT_AUTH_PRIVATE_KEY ===");
console.log(JSON.stringify(privateJwk));

console.log("\n=== PUBLIC KEY — paste into packages/core/src/web-bot-auth.ts ===");
console.log(JSON.stringify({ kty: "OKP", crv: "Ed25519", x: publicJwk.x, kid }, null, 2));
console.log(`\nkeyid (thumbprint): ${kid}\n`);
```

- [ ] **Step 2: Verify the script runs and emits both keys**

Run: `bun scripts/gen-web-bot-auth-key.ts`
Expected: prints a PRIVATE JWK line (with a `d` member) and a PUBLIC JWK block with `x` +
`kid`. Do NOT commit any printed key. (This output is the artifact the user provisions with.)

- [ ] **Step 3: Commit the script only**

```bash
git add scripts/gen-web-bot-auth-key.ts
git commit -m "chore(scripts): Web Bot Auth Ed25519 key generation helper"
```

- [ ] **Step 4: USER ACTION — provision the keys (manual; not done by the agent)**

This step changes a committed constant and a secret. The agent pastes the public key (a
non-secret) when the user provides it; the user provisions the private key themselves.

1. Run `bun scripts/gen-web-bot-auth-key.ts` and copy both outputs.
2. Paste the PUBLIC JWK's `x` and `kid` into `WEB_BOT_AUTH_PUBLIC_JWK` in
   `packages/core/src/web-bot-auth.ts`, then commit:
   `git commit -am "feat(core): provision Web Bot Auth public key"`.
3. Store the PRIVATE JWK in the Cloudflare **Secrets Store** (account-level — _not_
   `wrangler secret put`, which writes a worker-env secret the bindings don't read)
   under `WEB_BOT_AUTH_PRIVATE_KEY`. One secret serves both the api and discovery workers:
   ```bash
   # paste the private JWK at the prompt — omit --value so it doesn't land in shell history
   bunx wrangler secrets-store secret create a887a71cab084105b79706df23380723 \
     --name WEB_BOT_AUTH_PRIVATE_KEY --scopes workers --remote
   ```
   (Or add it via the dashboard → Manage Account → Secrets Store. The wrangler bindings
   already reference `secret_name: "WEB_BOT_AUTH_PRIVATE_KEY"`. See
   `docs/runbooks/web-bot-auth-registration.md`.)
4. Re-run `bun test packages/core/src/web-bot-auth.test.ts` and the directory route test —
   both now exercise the provisioned (200/JWKS) branch.

---

## Task 12: Verification + registration runbook

**Files:**

- Create: `docs/runbooks/web-bot-auth-registration.md`
- Modify: `README.md` (add a short pointer)

- [ ] **Step 1: Write the runbook**

```markdown
# Web Bot Auth — verification & Cloudflare registration

## Prerequisites

- Keys provisioned (plan Task 11 §4): public key committed, private key in Secrets Store.
- `/.well-known/http-message-signatures-directory` returns 200 + a JWKS on releases.sh.
- `/bot` page is live.

## Enable signing

Set `WEB_BOT_AUTH_ENABLED=true` in `vars` for the api + discovery workers and deploy
(branch deploy via GH Actions `deploy-workers.yml`, or merge to main).

## Verify the signature is well-formed

Send a signed request to Cloudflare's tester and check the status:

- `401` = signature is well-formed but the key is not yet known to Cloudflare (expected
  before registration).
- `200` = key known and verified (expected after registration is approved).
- `400` = malformed; fix before submitting.

Test endpoint: `https://crawltest.com/cdn-cgi/web-bot-auth`

Also run the public scanner: POST the site to `https://isitagentready.com/api/scan` and
confirm `checks.botAccessControl.webBotAuth.status: "pass"`.

## Submit the Bot Submission Form

Cloudflare dashboard → Manage Account → Configurations → Bot Submission Form:

| Field                     | Value                                                              |
| ------------------------- | ------------------------------------------------------------------ |
| Bot name                  | Releases                                                           |
| I own this bot            | checked                                                            |
| Bot documentation URL     | https://releases.sh/bot                                            |
| Short description         | Changelog indexer & registry crawler for AI agents and developers. |
| Bot type                  | Verified Bot                                                       |
| Bot crawler category      | AI Crawler                                                         |
| Verification method       | Request signature (beta)                                           |
| Validation instructions   | https://releases.sh/.well-known/http-message-signatures-directory  |
| User-Agents header values | releases/0.1 (+https://releases.sh)                                |
| User-Agents match pattern | releases                                                           |

## After approval

Re-run the crawltest endpoint; expect `200`. Browser-Rendering traffic remains identified as
Cloudflare Browser Rendering (separate, already-verified identity) — this is expected and
documented in the design spec.
```

- [ ] **Step 2: Add a README pointer**

In `README.md`, under the relevant operations/architecture section, add one line:

```markdown
- **Web Bot Auth:** the crawler signs direct fetches and publishes a key directory at
  `/.well-known/http-message-signatures-directory`. See
  `docs/runbooks/web-bot-auth-registration.md`.
```

- [ ] **Step 3: Commit**

```bash
git add docs/runbooks/web-bot-auth-registration.md README.md
git commit -m "docs: Web Bot Auth verification + Cloudflare registration runbook"
```

---

## Final verification

- [ ] **Full type-check (root + workers)**

Run: `npx tsc --noEmit && cd workers/api && npx tsc --noEmit && cd ../discovery && npx tsc --noEmit && cd ../..`
Expected: no errors.

- [ ] **Full test suite**

Run: `bun test`
Expected: PASS, including the three new test files.

- [ ] **Lint + format**

Run: `bun run lint && bun run format:check`
Expected: clean (the pre-commit hook also runs prettier).
