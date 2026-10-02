import { describe, it, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { createTestDb } from "./setup";
import { oauthClient } from "../src/db/schema-auth.js";
import { createAuth } from "../src/auth/index.js";
import {
  createOAuthClient,
  updateClientFlags,
  type OAuthClientAdapter,
} from "../src/auth/oauth-clients.js";
import type { AuthEmailMessage } from "../src/auth/email.js";

// The consent page's "Verified" badge reads `official` from
// /oauth2/public-client. Self-registered clients (DCR / CIMD) choose their own
// name, logo, and homepage, so only the operator's `metadata.official` flag may
// turn it on — never anything in a registration body.

const env = {
  BETTER_AUTH_URL: "https://api.releases.localhost",
  BETTER_AUTH_SECRET: "test-secret-do-not-use-in-prod-0123456789",
} as never;
const BASE = "https://api.releases.localhost/api/auth";
const PASSWORD = "correct-horse-battery";

async function setup() {
  const db = createTestDb();
  const emails: AuthEmailMessage[] = [];
  const auth = await createAuth(env, undefined, {
    db,
    sendEmail: (m) => {
      emails.push(m);
    },
  });
  await auth.api.signUpEmail({
    body: { email: "pat@example.com", password: PASSWORD, name: "Pat" },
  });
  const token = /token=([^&\s]+)/.exec(emails[0]?.text ?? "")?.[1];
  await auth.api.verifyEmail({ query: { token: token as string } });
  const signIn = await auth.api.signInEmail({
    body: { email: "pat@example.com", password: PASSWORD },
    returnHeaders: true,
  });
  const cookie = (signIn.headers.get("set-cookie") ?? "")
    .split(/,(?=\s*[\w.-]+=)/)
    .map((c) => c.split(";")[0]!.trim())
    .join("; ");
  const adapter = (await auth.$context).adapter as unknown as OAuthClientAdapter;
  return { db, auth, cookie, adapter };
}

async function register(auth: Awaited<ReturnType<typeof setup>>["auth"], extra = {}) {
  const res = await auth.handler(
    new Request(`${BASE}/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Claude",
        client_uri: "https://claude.ai",
        redirect_uris: ["https://attacker.example.com/cb"],
        token_endpoint_auth_method: "none",
        ...extra,
      }),
    }),
  );
  return { res, body: (await res.json()) as { client_id?: string } };
}

async function publicClient(
  auth: Awaited<ReturnType<typeof setup>>["auth"],
  cookie: string,
  clientId: string,
) {
  const res = await auth.handler(
    new Request(`${BASE}/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`, {
      headers: { cookie },
    }),
  );
  return { status: res.status, body: (await res.json()) as { official?: unknown } };
}

describe("/oauth2/public-client official flag", () => {
  it("is false for a self-registered DCR client", async () => {
    const { auth, cookie } = await setup();
    const { body } = await register(auth);
    const { status, body: pc } = await publicClient(auth, cookie, body.client_id!);
    expect(status).toBe(200);
    expect(pc.official).toBe(false);
  });

  it("cannot be set from a DCR body (official / metadata.official)", async () => {
    const { db, auth, cookie } = await setup();
    const { res, body } = await register(auth, {
      official: true,
      metadata: { official: true },
    });
    if (!res.ok) {
      // Refusing the registration outright is also acceptable.
      expect(await db.select().from(oauthClient)).toHaveLength(0);
      return;
    }
    const [row] = await db
      .select()
      .from(oauthClient)
      .where(eq(oauthClient.clientId, body.client_id!));
    expect((row?.metadata as Record<string, unknown> | null)?.official).toBeUndefined();
    const { body: pc } = await publicClient(auth, cookie, body.client_id!);
    expect(pc.official).toBe(false);
  });

  it("is true for an admin-provisioned client and follows the admin flag", async () => {
    const { auth, cookie, adapter } = await setup();
    const { client } = await createOAuthClient(adapter, {
      name: "Releases CLI",
      redirectUris: ["http://127.0.0.1:8976/callback"],
      scopes: ["openid", "read"],
      tokenEndpointAuthMethod: "none",
    });
    expect(client.official).toBe(true);
    expect((await publicClient(auth, cookie, client.clientId)).body.official).toBe(true);

    const updated = await updateClientFlags(adapter, client.clientId, { official: false });
    expect(updated?.official).toBe(false);
    expect((await publicClient(auth, cookie, client.clientId)).body.official).toBe(false);
  });

  it("an operator can verify a self-registered client", async () => {
    const { auth, cookie, adapter } = await setup();
    const { body } = await register(auth);
    await updateClientFlags(adapter, body.client_id!, { official: true });
    expect((await publicClient(auth, cookie, body.client_id!)).body.official).toBe(true);
  });

  it("still 404s for an unknown client", async () => {
    const { auth, cookie } = await setup();
    const { status } = await publicClient(auth, cookie, "nope");
    expect(status).toBe(404);
  });
});
