/**
 * Service layer for admin OAuth client management (#1482). Operates on the
 * Better Auth *context adapter* — the same adapter the oauth-provider plugin
 * reads through — so JSON-field encoding stays symmetric and there is no
 * session gate (the plugin's /admin/oauth2/create-client endpoint requires a
 * user session, which our root-key route does not have). Secret generation +
 * hashing replicate the plugin's own primitives so stored secrets verify
 * against its `verifyStoredClientSecret`.
 */
import { generateRandomString } from "better-auth/crypto";
import { createHash } from "@better-auth/utils/hash";
import { base64Url } from "@better-auth/utils/base64";

/** Extends the relk_/relu_/relo_ credential family; the operator-facing secret prefix. */
export const CLIENT_SECRET_PREFIX = "reloc_";

const OAUTH_CLIENT_MODEL = "oauthClient";

/** Minimal structural view of the Better Auth DB adapter we depend on. */
export interface AdapterWhere {
  field: string;
  value: unknown;
  operator?: string;
}
export interface OAuthClientAdapter {
  create(args: { model: string; data: Record<string, unknown> }): Promise<Record<string, unknown>>;
  findOne(args: { model: string; where: AdapterWhere[] }): Promise<Record<string, unknown> | null>;
  findMany(args: { model: string; where?: AdapterWhere[] }): Promise<Record<string, unknown>[]>;
  update(args: {
    model: string;
    where: AdapterWhere[];
    update: Record<string, unknown>;
  }): Promise<unknown>;
  delete(args: { model: string; where: AdapterWhere[] }): Promise<unknown>;
}

export interface CreateClientInput {
  name?: string;
  redirectUris: string[];
  scopes: string[];
  /** Maps to skip_consent — only the admin path can set this. */
  trusted?: boolean;
  type?: "web" | "native" | "user-agent-based";
  tokenEndpointAuthMethod?: "none" | "client_secret_basic" | "client_secret_post";
  grantTypes?: string[];
  requirePKCE?: boolean;
  clientUri?: string;
  logoUri?: string;
}

/** Public, secret-free view returned by every read path. */
export interface PublicOAuthClient {
  clientId: string;
  name: string | null;
  redirectUris: string[];
  scopes: string[];
  trusted: boolean;
  disabled: boolean;
  public: boolean;
  type: string | null;
  tokenEndpointAuthMethod: string | null;
  createdAt: unknown;
  updatedAt: unknown;
}

export function generateClientSecret(): string {
  return generateRandomString(32, "a-z", "A-Z");
}

/** base64url(SHA-256(secret)), no padding — verbatim match for the plugin's defaultHasher. */
export async function hashClientSecret(secret: string): Promise<string> {
  const digest = await createHash("SHA-256").digest(new TextEncoder().encode(secret));
  return base64Url.encode(new Uint8Array(digest), { padding: false });
}

/** Project a raw adapter row to the secret-free public shape. */
export function toPublicClient(row: Record<string, unknown>): PublicOAuthClient {
  return {
    clientId: row.clientId as string,
    name: (row.name as string | null) ?? null,
    redirectUris: (row.redirectUris as string[]) ?? [],
    scopes: (row.scopes as string[]) ?? [],
    trusted: Boolean(row.skipConsent),
    disabled: Boolean(row.disabled),
    public: Boolean(row.public),
    type: (row.type as string | null) ?? null,
    tokenEndpointAuthMethod: (row.tokenEndpointAuthMethod as string | null) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function createOAuthClient(
  adapter: OAuthClientAdapter,
  input: CreateClientInput,
): Promise<{ client: PublicOAuthClient; secret?: string }> {
  const isPublic = input.tokenEndpointAuthMethod === "none";
  const rawSecret = isPublic ? undefined : generateClientSecret();
  const now = new Date();
  const data: Record<string, unknown> = {
    clientId: generateRandomString(32, "a-z", "A-Z"),
    clientSecret: rawSecret ? await hashClientSecret(rawSecret) : undefined,
    name: input.name ?? null,
    redirectUris: input.redirectUris,
    scopes: input.scopes,
    grantTypes: input.grantTypes ?? ["authorization_code"],
    responseTypes: ["code"],
    tokenEndpointAuthMethod: isPublic
      ? "none"
      : (input.tokenEndpointAuthMethod ?? "client_secret_basic"),
    type: input.type ?? (isPublic ? "native" : "web"),
    public: isPublic,
    requirePKCE: input.requirePKCE ?? true,
    disabled: false,
    skipConsent: input.trusted ?? false,
    uri: input.clientUri ?? null,
    icon: input.logoUri ?? null,
    createdAt: now,
    updatedAt: now,
  };
  const created = await adapter.create({ model: OAUTH_CLIENT_MODEL, data });
  return {
    client: toPublicClient(created),
    secret: rawSecret ? CLIENT_SECRET_PREFIX + rawSecret : undefined,
  };
}
