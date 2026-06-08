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
