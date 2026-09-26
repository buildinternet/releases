import { describe, it, expect } from "bun:test";
import { createTestDb } from "./setup";
import { oauthClient } from "../src/db/schema-auth.js";
import { DCR_SCOPES } from "../src/auth/entitlement.js";
import { createAuth } from "../src/auth/index.js";
import { cimdClientRowPatch, createWorkersClientMetadataFetch } from "../src/auth/oauth-cimd.js";

const baseEnv = {
  BETTER_AUTH_URL: "https://api.releases.localhost",
  BETTER_AUTH_SECRET: "test-secret-do-not-use-in-prod-0123456789",
} as never;

const CLAUDE_CLIENT_ID = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";

/** The document claude.ai publishes (fetched 2026-09-26), incl. its jwt-bearer grant. */
const claudeDocument = {
  client_id: CLAUDE_CLIENT_ID,
  client_name: "Claude",
  client_uri: "https://claude.ai",
  redirect_uris: [CLAUDE_REDIRECT],
  grant_types: [
    "authorization_code",
    "refresh_token",
    "urn:ietf:params:oauth:grant-type:jwt-bearer",
  ],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};

/** Transport stub serving one metadata document per URL; records fetched URLs. */
function stubDocuments(docs: Record<string, unknown>) {
  const fetched: string[] = [];
  const fetchClientMetadataResource = async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    fetched.push(url);
    const doc = docs[url];
    if (!doc) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(doc), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetched, fetchClientMetadataResource };
}

function authorizeUrl(clientId: string, redirectUri: string, scope = "read write") {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state: "xyz",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    resource: "https://api.releases.localhost",
  });
  return `https://api.releases.localhost/api/auth/oauth2/authorize?${params}`;
}

describe("CIMD (client ID metadata documents)", () => {
  it("advertises client_id_metadata_document_supported and keeps DCR", async () => {
    const auth = await createAuth(baseEnv, undefined, {
      db: createTestDb(),
      sendEmail: () => {},
    });
    const res = await auth.handler(
      new Request("https://api.releases.localhost/api/auth/.well-known/oauth-authorization-server"),
    );
    const meta = (await res.json()) as {
      client_id_metadata_document_supported?: boolean;
      registration_endpoint?: string;
    };
    expect(meta.client_id_metadata_document_supported).toBe(true);
    expect(meta.registration_endpoint).toContain("/oauth2/register");
  });

  it("resolves Claude's published identity at authorize into a DCR-capped client", async () => {
    const db = createTestDb();
    const stub = stubDocuments({ [CLAUDE_CLIENT_ID]: claudeDocument });
    const auth = await createAuth(baseEnv, undefined, {
      db,
      sendEmail: () => {},
      fetchClientMetadataResource: stub.fetchClientMetadataResource,
    });

    const res = await auth.handler(
      new Request(authorizeUrl(CLAUDE_CLIENT_ID, CLAUDE_REDIRECT), { redirect: "manual" }),
    );
    const location = res.headers.get("location") ?? "";
    // Unauthenticated → login redirect, never an error back to Claude's callback.
    expect(location).not.toContain("error=");
    expect(location.startsWith(CLAUDE_REDIRECT)).toBe(false);
    expect(stub.fetched).toEqual([CLAUDE_CLIENT_ID]);

    const rows = await db.select().from(oauthClient);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.clientId).toBe(CLAUDE_CLIENT_ID);
    expect(row.clientDiscoveryId).toBe("cimd");
    expect(row.clientSecret ?? null).toBeNull();
    expect(row.skipConsent ?? false).toBe(false);
    expect(row.tokenEndpointAuthMethod).toBe("none");
    expect([...(row.scopes ?? [])].toSorted()).toEqual([...DCR_SCOPES].toSorted());
  });

  it("resolves VS Code's document (device_code grant, loopback redirect)", async () => {
    const db = createTestDb();
    const clientId = "https://vscode.dev/oauth/client-metadata.json";
    const stub = stubDocuments({
      [clientId]: {
        client_name: "Visual Studio Code",
        grant_types: [
          "authorization_code",
          "refresh_token",
          "urn:ietf:params:oauth:grant-type:device_code",
        ],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        application_type: "native",
        client_id: clientId,
        client_uri: "https://vscode.dev/product",
        redirect_uris: ["http://127.0.0.1:33418/", "https://vscode.dev/redirect"],
      },
    });
    const auth = await createAuth(baseEnv, undefined, {
      db,
      sendEmail: () => {},
      fetchClientMetadataResource: stub.fetchClientMetadataResource,
    });
    const res = await auth.handler(
      new Request(authorizeUrl(clientId, "http://127.0.0.1:33418/"), { redirect: "manual" }),
    );
    expect(res.headers.get("location") ?? "").not.toContain("error=");
    expect(await db.select().from(oauthClient)).toHaveLength(1);
  });

  it("refuses a document carrying server-owned fields (skip_consent)", async () => {
    const db = createTestDb();
    const clientId = "https://agent.example.com/client.json";
    const redirect = "https://agent.example.com/callback";
    const stub = stubDocuments({
      [clientId]: {
        client_id: clientId,
        client_name: "Pushy agent",
        redirect_uris: [redirect],
        token_endpoint_auth_method: "none",
        skip_consent: true,
      },
    });
    const auth = await createAuth(baseEnv, undefined, {
      db,
      sendEmail: () => {},
      fetchClientMetadataResource: stub.fetchClientMetadataResource,
    });
    await auth.handler(new Request(authorizeUrl(clientId, redirect), { redirect: "manual" }));

    expect(await db.select().from(oauthClient)).toHaveLength(0);
  });

  // Stricter than DCR (which caps): the plugin validates a document's `scope`
  // against DCR_SCOPES and refuses the client. Fail closed; no published MCP
  // client document we've seen (Claude, VS Code, MCPJam) sets `scope`.
  it("refuses a document that declares write/admin scope", async () => {
    const db = createTestDb();
    const clientId = "https://agent.example.com/greedy.json";
    const redirect = "https://agent.example.com/callback";
    const stub = stubDocuments({
      [clientId]: {
        client_id: clientId,
        client_name: "Greedy agent",
        redirect_uris: [redirect],
        token_endpoint_auth_method: "none",
        scope: "read write admin",
      },
    });
    const auth = await createAuth(baseEnv, undefined, {
      db,
      sendEmail: () => {},
      fetchClientMetadataResource: stub.fetchClientMetadataResource,
    });
    await auth.handler(new Request(authorizeUrl(clientId, redirect), { redirect: "manual" }));
    expect(await db.select().from(oauthClient)).toHaveLength(0);
  });

  it("refuses a redirect_uri the document does not list", async () => {
    const db = createTestDb();
    const stub = stubDocuments({ [CLAUDE_CLIENT_ID]: claudeDocument });
    const auth = await createAuth(baseEnv, undefined, {
      db,
      sendEmail: () => {},
      fetchClientMetadataResource: stub.fetchClientMetadataResource,
    });
    const attacker = "https://evil.example.com/callback";
    const res = await auth.handler(
      new Request(authorizeUrl(CLAUDE_CLIENT_ID, attacker), { redirect: "manual" }),
    );
    // Never bounce the browser (or a code) to an unregistered redirect: the AS
    // sends it to its own error page instead.
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith(attacker)).toBe(false);
    expect(location).toContain("/api/auth/error?error=invalid_redirect");
  });

  it("rejects a document with a shared-secret auth method", async () => {
    const db = createTestDb();
    const clientId = "https://agent.example.com/secret.json";
    const redirect = "https://agent.example.com/callback";
    const stub = stubDocuments({
      [clientId]: {
        client_id: clientId,
        client_name: "Secret agent",
        redirect_uris: [redirect],
        token_endpoint_auth_method: "client_secret_basic",
      },
    });
    const auth = await createAuth(baseEnv, undefined, {
      db,
      sendEmail: () => {},
      fetchClientMetadataResource: stub.fetchClientMetadataResource,
    });
    await auth.handler(new Request(authorizeUrl(clientId, redirect), { redirect: "manual" }));
    expect(await db.select().from(oauthClient)).toHaveLength(0);
  });
});

function recordingFetch(response: Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return response;
  }) as unknown as typeof fetch;
  return { calls, impl };
}

describe("createWorkersClientMetadataFetch", () => {
  it("asks workerd for manual redirects even when the plugin says 'error'", async () => {
    const { calls, impl } = recordingFetch(new Response("{}", { status: 200 }));
    const transport = createWorkersClientMetadataFetch(impl);
    await transport(CLAUDE_CLIENT_ID, { redirect: "error", headers: { accept: "x" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.redirect).toBe("manual");
    expect(calls[0]?.init?.method).toBe("GET");
  });

  it("throws on a redirect response", async () => {
    const { impl } = recordingFetch(
      new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }),
    );
    const transport = createWorkersClientMetadataFetch(impl);
    await expect(transport(CLAUDE_CLIENT_ID)).rejects.toThrow(/redirect/);
  });

  it("passes a 304 through for conditional revalidation", async () => {
    const { impl } = recordingFetch(new Response(null, { status: 304 }));
    const transport = createWorkersClientMetadataFetch(impl);
    expect((await transport(CLAUDE_CLIENT_ID)).status).toBe(304);
  });

  it("refuses non-https URLs and non-GET methods", async () => {
    const { calls, impl } = recordingFetch(new Response("{}"));
    const transport = createWorkersClientMetadataFetch(impl);
    await expect(transport("http://claude.ai/doc")).rejects.toThrow(/https/);
    await expect(transport(CLAUDE_CLIENT_ID, { method: "POST" })).rejects.toThrow(/GET/);
    expect(calls).toHaveLength(0);
  });

  it("refuses loopback, private, and metadata hosts", async () => {
    const { calls, impl } = recordingFetch(new Response("{}"));
    const transport = createWorkersClientMetadataFetch(impl);
    for (const url of [
      "https://127.0.0.1/doc",
      "https://localhost/doc",
      "https://10.0.0.5/doc",
      "https://169.254.169.254/latest",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- sequential assertions
      await expect(transport(url)).rejects.toThrow(/rejected/);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("cimdClientRowPatch", () => {
  it("returns undefined for a row already inside the DCR ceiling", () => {
    expect(
      cimdClientRowPatch({ scopes: [...DCR_SCOPES], skipConsent: false, requirePKCE: true }),
    ).toBeUndefined();
  });

  it("clamps privileged scopes, skip_consent, and M2M scopes", () => {
    expect(
      cimdClientRowPatch({
        scopes: ["read", "write", "admin"],
        skipConsent: true,
        requirePKCE: false,
        clientCredentialsScopes: ["admin"],
      }),
    ).toEqual({
      scopes: ["read"],
      skipConsent: false,
      requirePKCE: true,
      clientCredentialsScopes: null,
    });
  });
});
