import { describe, it, expect } from "bun:test";
import { createTestDb } from "./setup";
import { createAuth } from "../src/auth/index.js";
import {
  CLIENT_SECRET_PREFIX,
  hashClientSecret,
  generateClientSecret,
  createOAuthClient,
  type OAuthClientAdapter,
} from "../src/auth/oauth-clients.js";

const baseEnv = {
  BETTER_AUTH_URL: "https://api.releases.localhost",
  BETTER_AUTH_SECRET: "test-secret-do-not-use-in-prod-0123456789",
} as never;

async function makeAdapter(): Promise<OAuthClientAdapter> {
  const auth = await createAuth(baseEnv, undefined, { db: createTestDb(), sendEmail: () => {} });
  return (await auth.$context).adapter as unknown as OAuthClientAdapter;
}

describe("oauth-clients secret helpers", () => {
  it("generateClientSecret yields a 32-char alnum string", () => {
    const s = generateClientSecret();
    expect(s).toMatch(/^[a-zA-Z]{32}$/);
  });

  it("hashClientSecret is base64url SHA-256, unprefixed and deterministic", async () => {
    const h1 = await hashClientSecret("hunter2");
    const h2 = await hashClientSecret("hunter2");
    expect(h1).toBe(h2);
    expect(h1).not.toContain("hunter2");
    expect(h1).not.toMatch(/[+/=]/); // base64url, no padding
  });
});

describe("createOAuthClient", () => {
  it("creates a confidential client: prefixed secret returned, hash stored, projection omits secret", async () => {
    const adapter = await makeAdapter();
    const { client, secret } = await createOAuthClient(adapter, {
      name: "Test App",
      redirectUris: ["https://app.example.com/cb"],
      scopes: ["read"],
    });
    expect(secret).toMatch(new RegExp(`^${CLIENT_SECRET_PREFIX}`));
    expect(client.public).toBe(false);
    expect(client.trusted).toBe(false);
    expect(client.redirectUris).toEqual(["https://app.example.com/cb"]);
    expect(client.scopes).toEqual(["read"]);
    expect(client).not.toHaveProperty("clientSecret");

    const raw = secret!.slice(CLIENT_SECRET_PREFIX.length);
    const row = await adapter.findOne({
      model: "oauthClient",
      where: [{ field: "clientId", value: client.clientId }],
    });
    expect(row?.clientSecret).toBe(await hashClientSecret(raw));
    expect(row?.clientSecret).not.toContain(raw);
  });

  it("creates a public client (token_endpoint_auth_method=none): no secret", async () => {
    const adapter = await makeAdapter();
    const { client, secret } = await createOAuthClient(adapter, {
      name: "MCP Client",
      redirectUris: ["https://host.example.com/cb"],
      scopes: ["read"],
      tokenEndpointAuthMethod: "none",
    });
    expect(secret).toBeUndefined();
    expect(client.public).toBe(true);
    expect(client.tokenEndpointAuthMethod).toBe("none");
  });

  it("creates a trusted client when trusted=true (skip_consent)", async () => {
    const adapter = await makeAdapter();
    const { client } = await createOAuthClient(adapter, {
      redirectUris: ["https://app.example.com/cb"],
      scopes: ["read", "write"],
      trusted: true,
    });
    expect(client.trusted).toBe(true);
  });
});

import {
  listOAuthClients,
  getOAuthClient,
  setClientDisabled,
  setClientTrusted,
  rotateClientSecret,
  deleteOAuthClient,
} from "../src/auth/oauth-clients.js";

import type { CreateClientInput } from "../src/auth/oauth-clients.js";

async function seed(adapter: OAuthClientAdapter, over: Partial<CreateClientInput> = {}) {
  return createOAuthClient(adapter, {
    redirectUris: ["https://app.example.com/cb"],
    scopes: ["read"],
    ...over,
  });
}

describe("oauth-clients read + mutate", () => {
  it("list and get omit the secret", async () => {
    const adapter = await makeAdapter();
    const { client } = await seed(adapter);
    const list = await listOAuthClients(adapter);
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty("clientSecret");
    const got = await getOAuthClient(adapter, client.clientId);
    expect(got?.clientId).toBe(client.clientId);
    expect(got).not.toHaveProperty("clientSecret");
    expect(await getOAuthClient(adapter, "missing")).toBeNull();
  });

  it("setClientDisabled flips the column and reports not-found", async () => {
    const adapter = await makeAdapter();
    const { client } = await seed(adapter);
    expect(await setClientDisabled(adapter, client.clientId, true)).toBe(true);
    const row = await adapter.findOne({
      model: "oauthClient",
      where: [{ field: "clientId", value: client.clientId }],
    });
    expect(Boolean(row?.disabled)).toBe(true);
    expect(await setClientDisabled(adapter, "missing", true)).toBe(false);
  });

  it("setClientTrusted toggles skip_consent", async () => {
    const adapter = await makeAdapter();
    const { client } = await seed(adapter);
    expect(await setClientTrusted(adapter, client.clientId, true)).toBe(true);
    const got = await getOAuthClient(adapter, client.clientId);
    expect(got?.trusted).toBe(true);
  });

  it("rotateClientSecret changes the stored hash; new secret verifies", async () => {
    const adapter = await makeAdapter();
    const { client, secret } = await seed(adapter);
    const before = (
      await adapter.findOne({
        model: "oauthClient",
        where: [{ field: "clientId", value: client.clientId }],
      })
    )?.clientSecret;
    const res = await rotateClientSecret(adapter, client.clientId);
    expect(res.status).toBe("ok");
    if (res.status !== "ok") throw new Error("unreachable");
    expect(res.secret).toMatch(new RegExp(`^${CLIENT_SECRET_PREFIX}`));
    expect(res.secret).not.toBe(secret);
    const after = (
      await adapter.findOne({
        model: "oauthClient",
        where: [{ field: "clientId", value: client.clientId }],
      })
    )?.clientSecret;
    expect(after).not.toBe(before);
    expect(after).toBe(await hashClientSecret(res.secret.slice(CLIENT_SECRET_PREFIX.length)));
  });

  it("rotateClientSecret refuses a public client and reports not-found", async () => {
    const adapter = await makeAdapter();
    const { client } = await seed(adapter, { tokenEndpointAuthMethod: "none" });
    expect((await rotateClientSecret(adapter, client.clientId)).status).toBe("public_no_secret");
    expect((await rotateClientSecret(adapter, "missing")).status).toBe("not_found");
  });

  it("deleteOAuthClient removes the row", async () => {
    const adapter = await makeAdapter();
    const { client } = await seed(adapter);
    expect(await deleteOAuthClient(adapter, client.clientId)).toBe(true);
    expect(await getOAuthClient(adapter, client.clientId)).toBeNull();
    expect(await deleteOAuthClient(adapter, client.clientId)).toBe(false);
  });
});
