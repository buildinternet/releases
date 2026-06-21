import {
  hashSecret,
  isUserApiKeyShaped,
  type PrincipalType,
} from "@buildinternet/releases-core/api-token";

/** `tokenId` prefix for an OAuth-JWT principal (#1483). No `api_tokens` row. */
export const OAUTH_JWT_TOKEN_PREFIX = "oauth_";

/** Stable identity input for a PII-clean consumption `consumerRef` (#1719). */
export type ConsumptionRefIdentity =
  | { kind: "root" }
  | { kind: "anonymous" }
  | { kind: "token"; tokenId: string };

/** Coarse principal label for consumption telemetry (#1700). PII-clean — a type,
 *  never an id/email/token. Shared by API and MCP so Axiom queries union both. */
export type ConsumptionPrincipal = "anonymous" | "machine_token" | "user_key" | "oauth" | "root";

export type ConsumptionAudience = "internal" | "external";

/** Auth-boundary input for building a consumption event. */
export type ConsumptionIdentity =
  | { kind: "root" }
  | { kind: "anonymous" }
  | {
      kind: "token";
      tokenId: string;
      /** `api_tokens.principal_type` for `relk_` machine tokens only. */
      machinePrincipalType?: PrincipalType;
    };

export type ConsumptionPayload = {
  component: "consumption";
  event: "consumption";
  surface: "api" | "mcp";
  principal: ConsumptionPrincipal;
  consumerRef: string;
  audience: ConsumptionAudience;
  principalOwner?: PrincipalType;
  operation: string;
};

export function consumptionRefIdentity(identity: ConsumptionIdentity): ConsumptionRefIdentity {
  if (identity.kind === "root") return { kind: "root" };
  if (identity.kind === "anonymous") return { kind: "anonymous" };
  return { kind: "token", tokenId: identity.tokenId };
}

export function consumptionPrincipal(identity: ConsumptionIdentity): ConsumptionPrincipal {
  if (identity.kind === "root") return "root";
  if (identity.kind === "anonymous") return "anonymous";
  if (isUserApiKeyShaped(identity.tokenId)) return "user_key";
  if (identity.tokenId.startsWith(OAUTH_JWT_TOKEN_PREFIX)) return "oauth";
  return "machine_token";
}

/** Internal vs external demand — `root` and `relk_`/`internal` are internal ops. */
export function consumptionAudience(identity: ConsumptionIdentity): ConsumptionAudience {
  if (identity.kind === "root") return "internal";
  if (identity.kind === "anonymous") return "external";
  if (isUserApiKeyShaped(identity.tokenId)) return "external";
  if (identity.tokenId.startsWith(OAUTH_JWT_TOKEN_PREFIX)) return "external";
  if (identity.machinePrincipalType === "internal") return "internal";
  return "external";
}

/** Finer owner bucket for dashboard segmentation (omitted for anonymous). */
export function consumptionPrincipalOwner(
  identity: ConsumptionIdentity,
): PrincipalType | undefined {
  if (identity.kind === "anonymous") return undefined;
  if (identity.kind === "root") return "internal";
  if (isUserApiKeyShaped(identity.tokenId)) return "user";
  if (identity.tokenId.startsWith(OAUTH_JWT_TOKEN_PREFIX)) return "user";
  return identity.machinePrincipalType;
}

/**
 * Non-reversible per-principal bucket for consumption telemetry (#1719).
 * Hashes a stable internal id (`relk_` row id, `relu_${keyId}`, `oauth_${sub}`),
 * never a raw token, email, or IP. `root` / `anonymous` are fixed labels.
 */
export async function consumptionConsumerRef(identity: ConsumptionRefIdentity): Promise<string> {
  if (identity.kind === "root") return "root";
  if (identity.kind === "anonymous") return "anonymous";
  return hashSecret(`consumption:${identity.tokenId}`);
}

/** Build one PII-clean consumption event — shared by API and MCP emit paths. */
export async function buildConsumptionPayload(opts: {
  surface: "api" | "mcp";
  identity: ConsumptionIdentity;
  operation: string;
}): Promise<ConsumptionPayload> {
  const principalOwner = consumptionPrincipalOwner(opts.identity);
  return {
    component: "consumption",
    event: "consumption",
    surface: opts.surface,
    principal: consumptionPrincipal(opts.identity),
    consumerRef: await consumptionConsumerRef(consumptionRefIdentity(opts.identity)),
    audience: consumptionAudience(opts.identity),
    ...(principalOwner ? { principalOwner } : {}),
    operation: opts.operation,
  };
}
